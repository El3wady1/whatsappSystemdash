const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const limits = require("./limitsService");

// الحالة: disconnected | connecting | qr | authenticated | ready | auth_failure
let currentStatus = "disconnected";
let currentQR = null;
let io = null;
let client = null;
let initializing = false;
let connectingSince = null; // بداية محاولة الاتصال الحالية (لكشف البطء/التعليق)
let lastDisconnect = null; // { reason, at } — آخر انقطاع (للتشخيص)
let disconnectTimes = []; // أوقات الانقطاعات الأخيرة (لكشف التقطع المتكرر)
let loadingInfo = { percent: null, message: null }; // تقدم تحميل واتساب ويب
let lastLoggedPercent = -1;
let authWatchdog = null;
const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || "180000", 10); // 3 دقائق

function clearAuthWatchdog() {
  if (authWatchdog) { clearTimeout(authWatchdog); authWatchdog = null; }
}
let reconnectAttempts = 0;
const RECONNECT_MAX = parseInt(process.env.RECONNECT_MAX_ATTEMPTS || "10", 10);

// Hooks يركّبها server.js (لتفادي الاعتماد الدائري مع queueService)
const hooks = { onReady: null, onDown: null, onOptoutKeyword: null };

function setSocketIO(socketIO) {
  io = socketIO;
}

function setHooks(h) {
  Object.assign(hooks, h);
}

function emitStatus(status, extra = {}) {
  currentStatus = status;
  if (io) io.emit("whatsapp-status", { status, ...extra });
}

function emitQR(qrImage) {
  currentQR = qrImage;
  if (io) io.emit("whatsapp-qr", { qr: qrImage });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getPuppeteerConfig() {
  const cfg = {
    headless: (process.env.HEADLESS || "true").toLowerCase() !== "false",
    // وصفة الذاكرة المنخفضة (~512MB): عملية واحدة + تعطيل كل ما هو غير ضروري
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process", // أهم توفير: يمنع تعدد عمليات Renderer
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--disable-component-extensions-with-background-pages",
      "--disable-crash-reporter",
      "--no-crashpad",
      "--mute-audio",
      "--no-first-run",
      "--window-size=800,600", // نافذة أصغر = ذاكرة رسوميات أقل
      "--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication"
    ]
  };
  if (process.env.CHROME_PATH) cfg.executablePath = process.env.CHROME_PATH;
  return cfg;
}

function getStopKeywords() {
  const raw = process.env.STOP_KEYWORDS || "إيقاف,ايقاف,الغاء,إلغاء,STOP,stop,unsubscribe";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function attachClientEvents(target) {
  target.on("qr", async (qr) => {
    try {
      const img = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
      emitStatus("qr");
      emitQR(img);
      console.log("[WhatsApp] تم توليد QR جديد");
    } catch (err) {
      console.error("[WhatsApp] خطأ توليد QR:", err.message);
    }
  });

  target.on("loading_screen", (percent, message) => {
    loadingInfo = { percent, message: message || null };
    if (typeof percent === "number" && percent - lastLoggedPercent >= 20) {
      lastLoggedPercent = percent;
      console.log(`[WhatsApp] تحميل واتساب ويب: ${percent}% ${message || ""}`);
    }
    emitStatus("connecting", { percent, message });
  });

  target.on("authenticated", () => {
    emitStatus("authenticated");
    console.log("[WhatsApp] تمت المصادقة — بانتظار اكتمال التحميل...");
    // مراقب التعليق: إذا لم يكتمل التحميل خلال المهلة، أعد التوليد تلقائياً
    clearAuthWatchdog();
    authWatchdog = setTimeout(() => {
      if (currentStatus !== "ready") {
        console.error("[WhatsApp] ⏱ تعليق بعد المسح — إعادة توليد QR تلقائياً");
        if (io) io.emit("alert", {
          type: "auth-stuck",
          message: "تعليق بعد مسح QR — جارٍ توليد كود جديد. امسح الكود الجديد."
        });
        connectingSince = Date.now();
        loadingInfo = { percent: null, message: null };
        lastLoggedPercent = -1;
        initialize().catch((e) => console.error("[WhatsApp]", e.message));
      }
    }, AUTH_TIMEOUT_MS);
  });

  target.on("ready", () => {
    currentQR = null;
    reconnectAttempts = 0;
    connectingSince = null;
    loadingInfo = { percent: 100, message: null };
    clearAuthWatchdog();
    emitStatus("ready");
    if (io) io.emit("whatsapp-qr", { qr: null });
    console.log("[WhatsApp] العميل جاهز ✅");
    limits.ensureWarmupStart();
    if (hooks.onReady) hooks.onReady();
  });

  target.on("auth_failure", (msg) => {
    emitStatus("auth_failure", { message: msg });
    console.error("[WhatsApp] فشل المصادقة:", msg);
    if (hooks.onDown) hooks.onDown("auth_failure");
  });

  target.on("disconnected", async (reason) => {
    console.warn("[WhatsApp] انقطع الاتصال:", reason);
    emitStatus("disconnected", { reason });
    currentQR = null;
    clearAuthWatchdog();
    loadingInfo = { percent: null, message: null };
    // توثيق الانقطاع + كشف التقطع المتكرر
    const now = Date.now();
    lastDisconnect = { reason: String(reason), at: now };
    disconnectTimes.push(now);
    disconnectTimes = disconnectTimes.filter((t) => now - t < 10 * 60 * 1000);
    if (disconnectTimes.length >= 3 && io) {
      io.emit("alert", {
        type: "flapping",
        message: `انقطع الاتصال ${disconnectTimes.length} مرات خلال 10 دقائق (آخر سبب: ${reason}). السبب الغالب ذاكرة غير كافية — راجع Render Events لرسائل Out of memory.`
      });
    }
    if (hooks.onDown) hooks.onDown(String(reason));
    try { await target.destroy().catch(() => {}); } catch (_) {}
    scheduleReconnect();
  });

  // الاستماع لكلمات الإيقاف: "إيقاف" / STOP / إلغاء ...
  target.on("message", async (msg) => {
    try {
      if (!msg.from || msg.from.endsWith("@g.us")) return; // تجاهل المجموعات
      const body = (msg.body || "").trim().toLowerCase();
      if (!body) return;
      if (getStopKeywords().includes(body)) {
        const phone = msg.from.replace("@c.us", "");
        console.log(`[WhatsApp] طلب إيقاف من ${limits.maskPhone(phone)}`);
        if (hooks.onOptoutKeyword) hooks.onOptoutKeyword(phone);
        try { await msg.reply("تم إيقاف الرسائل. لن تصلك رسائل جديدة منا."); } catch (_) {}
      }
    } catch (_) {}
  });
}

function scheduleReconnect() {
  if (reconnectAttempts >= RECONNECT_MAX) {
    console.error(`[WhatsApp] توقف إعادة الاتصال بعد ${RECONNECT_MAX} محاولات. أعد تشغيل السيرفر يدوياً.`);
    if (io) io.emit("alert", { type: "reconnect-gave-up", message: "تعذر إعادة الاتصال تلقائياً. أعد تشغيل السيرفر." });
    return;
  }
  // exponential backoff: 5s, 10s, 20s ... بحد أقصى 5 دقائق
  const delay = Math.min(Math.pow(2, reconnectAttempts) * 5000, 5 * 60 * 1000);
  reconnectAttempts++;
  console.log(`[WhatsApp] إعادة الاتصال #${reconnectAttempts} بعد ${Math.round(delay / 1000)} ثانية...`);
  setTimeout(() => initialize().catch((e) => console.error("[WhatsApp]", e.message)), delay);
}

async function initialize() {
  if (initializing) return;
  initializing = true;
  if (currentStatus !== "ready") {
    emitStatus("connecting");
    connectingSince = Date.now(); // بداية محاولة جديدة
  }
  try {
    if (client) {
      try { await client.destroy().catch(() => {}); } catch (_) {}
      client = null;
    }
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "main-session",
        // يدعم مساراً خارجياً للتخزين الدائم (Render Disk / Docker volume)
        dataPath: process.env.AUTH_DIR || path.join(__dirname, "..", ".wwebjs_auth")
      }),
      puppeteer: getPuppeteerConfig()
      // بدون تثبيت نسخة ويب: يستخدم النسخة المرفقة مع المكتبة (الأكثر توافقاً —
      // التثبيت على نسخة قديمة سبب شائع للتعليق بعد مسح QR)
    });
    attachClientEvents(client);
    await client.initialize();
    console.log("[WhatsApp] جاري تهيئة العميل...");
  } catch (err) {
    console.error("[WhatsApp] خطأ initialize:", err.message);
    console.error("تلميح Chromium: ثبّت الاعتماديات (npx puppeteer browsers install chrome) أو حدد CHROME_PATH في .env");
    emitStatus("disconnected", { error: err.message });
    scheduleReconnect();
  } finally {
    initializing = false;
  }
}

function getStatus() {
  return { status: currentStatus, qr: currentQR, connectingSince, loading: loadingInfo, lastDisconnect };
}

function isReady() {
  return currentStatus === "ready" && !!client;
}

function cleanPhone(raw) {
  if (raw == null) return "";
  return String(raw).replace(/[\s+\-()]/g, "");
}

// إرجاع chatId إذا الرقم مسجل على واتساب، وإلا null
async function resolveNumber(clean) {
  if (!isReady()) return null;
  try {
    if (typeof client.getNumberId === "function") {
      const numId = await client.getNumberId(clean);
      if (numId && numId._serialized) return numId._serialized;
    }
    if (typeof client.isRegisteredUser === "function") {
      const ok = await client.isRegisteredUser(`${clean}@c.us`);
      if (ok) return `${clean}@c.us`;
    }
  } catch (_) {
    return null;
  }
  return null;
}

// إرسال فعلي واحد مع محاكاة "يكتب..."
async function sendText(chatId, text, typingMs = 3000) {
  if (!isReady()) throw new Error("واتساب غير متصل");
  const chat = await client.getChatById(chatId).catch(() => null);
  try {
    if (chat && typeof chat.sendStateTyping === "function") {
      await chat.sendStateTyping();
      await sleep(typingMs);
    } else {
      await sleep(1500);
    }
    await client.sendMessage(chatId, text);
    if (chat && typeof chat.clearState === "function") {
      await chat.clearState().catch(() => {});
    }
  } catch (err) {
    try {
      if (chat && typeof chat.clearState === "function") await chat.clearState().catch(() => {});
    } catch (_) {}
    throw err;
  }
}

async function logout() {
  clearAuthWatchdog();
  if (client) {
    try { await client.logout().catch(() => {}); } catch (e) {
      console.warn("[WhatsApp] logout:", e.message);
    }
    try { await client.destroy().catch(() => {}); } catch (_) {}
  }
  client = null;
  currentQR = null;
  reconnectAttempts = 0;
  clearSessionFolder();
  emitStatus("disconnected");
  setTimeout(() => initialize().catch(() => {}), 1500);
}

function clearSessionFolder() {
  try {
    const base = process.env.AUTH_DIR || path.join(__dirname, "..", ".wwebjs_auth");
    const sp = path.join(base, "session-main-session");
    if (fs.existsSync(sp)) {
      fs.rmSync(sp, { recursive: true, force: true });
      console.log("[WhatsApp] حُذفت ملفات الجلسة");
    }
    const cp = path.join(__dirname, "..", ".wwebjs_cache");
    if (fs.existsSync(cp)) fs.rmSync(cp, { recursive: true, force: true });
  } catch (err) {
    console.warn("[WhatsApp] تعذر حذف الجلسة:", err.message);
  }
}

module.exports = {
  initialize,
  setSocketIO,
  setHooks,
  getStatus,
  isReady,
  cleanPhone,
  resolveNumber,
  sendText,
  logout
};
