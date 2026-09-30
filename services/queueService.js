const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const limits = require("./limitsService");
const whatsapp = require("./whatsappService");
const db = require("./dbService");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const OPTOUT_FILE = path.join(DATA_DIR, "optout.json");

const CIRCUIT_BREAKER_FAILS = 3;
const HISTORY_KEEP = 100;

let io = null;
let loopStarted = false;
let busy = false;

// ===== حالة التشغيل (في الذاكرة) =====
const runtime = {
  paused: false,
  pauseReason: null,
  emergency: false,
  nextSendAt: null,
  consecutiveFailures: 0,
  sentSinceBreak: 0,
  breakEvery: randInt(limits.config.breakEveryMin, limits.config.breakEveryMax),
  onBreakUntil: null
};

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function randDelayMs() {
  return randInt(limits.config.minDelayS, limits.config.maxDelayS) * 1000;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
}

// ===== تخزين الطابور =====
function loadQueue() {
  ensureDataDir();
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const d = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      if (Array.isArray(d.jobs)) return d.jobs;
      if (Array.isArray(d)) return d;
    }
  } catch (_) {}
  return [];
}

let jobs = loadQueue();

function saveQueue() {
  try {
    ensureDataDir();
    const tmp = QUEUE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ jobs }, null, 2));
    fs.renameSync(tmp, QUEUE_FILE);
  } catch (e) {
    console.error("[queue] تعذر حفظ queue.json:", e.message);
  }
}

// إبقاء آخر HISTORY_KEEP من المنتهية + كل المعلقة
function pruneHistory() {
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "sending");
  const done = jobs.filter((j) => j.status !== "queued" && j.status !== "sending").slice(-HISTORY_KEEP);
  jobs = [...pending, ...done];
}

// ===== قائمة الإيقاف =====
function loadOptout() {
  ensureDataDir();
  try {
    if (fs.existsSync(OPTOUT_FILE)) {
      const d = JSON.parse(fs.readFileSync(OPTOUT_FILE, "utf8"));
      if (Array.isArray(d.numbers)) return d.numbers;
      if (Array.isArray(d)) return d;
    }
  } catch (_) {}
  return [];
}

function saveOptout(numbers) {
  try {
    ensureDataDir();
    const tmp = OPTOUT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ numbers }, null, 2));
    fs.renameSync(tmp, OPTOUT_FILE);
  } catch (e) {
    console.error("[queue] تعذر حفظ optout.json:", e.message);
  }
}

function isOptedOut(phone) {
  return loadOptout().includes(String(phone));
}

function addOptout(phone, source = "manual") {
  const list = loadOptout();
  const p = String(phone);
  if (!list.includes(p)) {
    list.push(p);
    saveOptout(list);
    console.log(`[optout] أُضيف ${limits.maskPhone(p)} (المصدر: ${source})`);
    // إزالة رسائله المعلقة من الطابور
    jobs
      .filter((j) => j.status === "queued" && j.phone === p)
      .forEach((j) => markTerminal(j, "skipped", "الرقم في قائمة الإيقاف", null));
    emitUpdate();
    if (io) io.emit("optout-added", { phone: limits.maskPhone(p), source });
  }
  return loadOptout();
}

function removeOptout(phone) {
  const p = String(phone);
  saveOptout(loadOptout().filter((n) => n !== p));
  emitUpdate();
  return loadOptout();
}

// ===== واجهة التحكم =====
function setSocketIO(socketIO) {
  io = socketIO;
}

function applyTemplate(text, name) {
  return String(text).replace(/\{name\}/g, name ? String(name) : "");
}

// توثيق الرسالة المنتهية في MongoDB (غير حاجب — لا يعطل الطابور عند انقطاع DB)
function logToDb(job, finalText) {
  db.logMessage({
    jobId: job.id,
    phone: job.phone,
    name: job.name || null,
    message: job.message,
    finalMessage: finalText || null,
    status: job.status,
    error: job.error || null,
    senderIp: job.senderIp || null,
    sentAt: job.sentAt ? new Date(job.sentAt) : null
  }).catch(() => {});
}

// تعليم مهمة كمنتهية + حفظ + توثيق
function markTerminal(job, status, error, finalText) {
  job.status = status;
  job.error = error || null;
  job.finishedAt = Date.now();
  if (status === "sent") job.sentAt = job.finishedAt;
  saveQueue();
  emitUpdate();
  logToDb(job, finalText);
}

function enqueue({ phone, message, name, overrideCooldown, senderIp, priority }) {
  const p = String(phone);
  if (isOptedOut(p)) {
    throw new Error("هذا الرقم في قائمة الإيقاف ولا يجوز مراسلته.");
  }
  if (!overrideCooldown) {
    const remain = limits.recipientCooldownRemaining(p);
    if (remain > 0) {
      const hrs = Math.ceil(remain / 3600000);
      throw new Error(`تمت مراسلة هذا الرقم مؤخراً. لا يجوز مجدداً قبل ~${hrs} ساعة (أو فعّل خيار التجاوز).`);
    }
  }
  const job = {
    id: uid(),
    phone: p,
    name: name ? String(name).slice(0, 60) : null,
    message: String(message),
    status: "queued", // queued | sending | sent | failed | skipped
    attempts: 0,
    overrideCooldown: !!overrideCooldown,
    senderIp: senderIp || null,
    createdAt: Date.now(),
    sentAt: null,
    finishedAt: null,
    error: null
  };
  if (priority) {
    // أولوية قصوى (مثل كود التأكيد): تُنقل لمقدمة الطابور
    const idx = jobs.findIndex((j) => j.status === "queued");
    jobs.splice(idx === -1 ? jobs.length : idx, 0, job);
  } else {
    jobs.push(job);
  }
  saveQueue();
  emitUpdate();
  const position = jobs.filter((j) => j.status === "queued").length;
  const avgDelay = ((limits.config.minDelayS + limits.config.maxDelayS) / 2) * 1000;
  let eta = position * avgDelay;
  if (runtime.nextSendAt && runtime.nextSendAt > Date.now()) {
    eta += runtime.nextSendAt - Date.now();
  }
  console.log(`[queue] أُضيفت رسالة إلى ${limits.maskPhone(p)} (الموضع ${position})`);
  return { id: job.id, position, etaSeconds: Math.ceil(eta / 1000) };
}

// إرسال جماعي: نفس القالب + اسم مخصص لكل مستقبل (يُعبأ {name} لكل واحد)
function enqueueBulk({ template, recipients, overrideCooldown, senderIp }) {
  const added = [];
  const failed = [];
  const list = Array.isArray(recipients) ? recipients : [];
  list.slice(0, 50).forEach((r) => {
    try {
      const clean = whatsapp.cleanPhone(r.phone);
      if (!/^\d{7,15}$/.test(clean)) throw new Error("رقم غير صالح");
      const res = enqueue({
        phone: clean,
        message: template,
        name: r.name ? String(r.name).trim().slice(0, 60) : null,
        overrideCooldown,
        senderIp
      });
      added.push({ phone: clean, name: r.name || null, id: res.id });
    } catch (e) {
      failed.push({ phone: String((r && r.phone) || ""), error: e.message });
    }
  });
  return { added, failed };
}

function pause(reason = "يدوي") {
  runtime.paused = true;
  runtime.pauseReason = reason;
  saveQueue();
  emitUpdate();
}

function resume() {
  runtime.paused = false;
  runtime.pauseReason = null;
  runtime.emergency = false;
  runtime.consecutiveFailures = 0;
  emitUpdate();
}

function clear() {
  const pending = jobs.filter((j) => j.status === "queued");
  pending.forEach((j) => markTerminal(j, "skipped", "حُذفت من الطابور يدوياً", null));
  runtime.nextSendAt = null;
  pruneHistory();
  saveQueue();
  emitUpdate();
  return { cleared: pending.length };
}

function emergencyStop() {
  runtime.emergency = true;
  runtime.paused = true;
  runtime.pauseReason = "إيقاف طارئ";
  runtime.nextSendAt = null;
  console.warn("[queue] ⛔ إيقاف طارئ!");
  emitUpdate();
}

function onConnectionDown(reason) {
  runtime.nextSendAt = null;
  if (!runtime.paused) {
    runtime.paused = true;
    runtime.pauseReason = "انقطع اتصال واتساب — متوقف تلقائياً";
  }
  emitUpdate();
  if (io) io.emit("alert", { type: "connection-down", message: "انقطع اتصال واتساب. توقف الطابور تلقائياً." });
}

function onConnectionUp() {
  if (runtime.pauseReason && runtime.pauseReason.startsWith("انقطع اتصال")) {
    runtime.paused = false;
    runtime.pauseReason = null;
  }
  emitUpdate();
}

// ===== حلقة المعالجة: رسالة واحدة في كل مرة، لا توازي أبداً =====
async function tick() {
  if (busy) return;
  if (runtime.paused || runtime.emergency) return;
  if (!whatsapp.isReady()) return;

  const job = jobs.find((j) => j.status === "queued");
  if (!job) return;

  const now = Date.now();

  // خارج ساعات الإرسال → انتظار
  if (!limits.isWithinAllowedHours(new Date(now))) {
    runtime.nextSendAt = limits.nextAllowedStartTs(now);
    emitUpdate();
    return;
  }

  // السقوف (ساعي/يومي/تسخين)
  const gate = limits.checkCanSend(now);
  if (!gate.ok) {
    runtime.nextSendAt = gate.waitUntil || now + 5 * 60 * 1000;
    emitUpdate();
    return;
  }

  // الفاصل العشوائي بين الرسائل
  if (runtime.nextSendAt && now < runtime.nextSendAt) return;

  busy = true;
  try {
    // قائمة الإيقاف
    if (isOptedOut(job.phone)) {
      markTerminal(job, "skipped", "الرقم في قائمة الإيقاف", applyTemplate(job.message, job.name));
      return;
    }

    // منع إزعاج نفس الرقم (إلا بتجاوز صريح)
    if (!job.overrideCooldown && limits.recipientCooldownRemaining(job.phone) > 0) {
      markTerminal(job, "skipped", "تمت مراسلته مؤخراً (منع التكرار)", applyTemplate(job.message, job.name));
      return;
    }

    // منع نفس النص حرفياً لعدد كبير في الساعة
    const finalText = applyTemplate(job.message, job.name);
    if (limits.sameTextCountLastHour(finalText) >= limits.config.maxSameTextPerHour) {
      runtime.nextSendAt = now + 10 * 60 * 1000;
      emitUpdate();
      return;
    }

    // التحقق أن الرقم مسجل على واتساب
    const chatId = await whatsapp.resolveNumber(job.phone);
    if (!chatId) {
      markTerminal(job, "skipped", "الرقم غير مسجل على واتساب", applyTemplate(job.message, job.name));
      return;
    }

    // مدة "يكتب..." حسب طول الرسالة
    const typingMs = Math.min(
      limits.config.typingMaxMs,
      Math.max(limits.config.typingMinMs, 2000 + finalText.length * 15)
    );

    job.status = "sending";
    job.attempts += 1;
    saveQueue(); emitUpdate();

    await whatsapp.sendText(chatId, finalText, typingMs);

    markTerminal(job, "sent", null, finalText);
    limits.recordSent(job.phone, finalText);
    runtime.consecutiveFailures = 0;
    runtime.sentSinceBreak += 1;

    // استراحة طويلة كل N رسالة
    if (runtime.sentSinceBreak >= runtime.breakEvery) {
      const breakMs = randInt(limits.config.breakMinS, limits.config.breakMaxS) * 1000;
      runtime.nextSendAt = Date.now() + breakMs;
      runtime.onBreakUntil = runtime.nextSendAt;
      runtime.sentSinceBreak = 0;
      runtime.breakEvery = randInt(limits.config.breakEveryMin, limits.config.breakEveryMax);
      console.log(`[queue] استراحة ${Math.round(breakMs / 60000)} دقائق بعد دفعة رسائل`);
    } else {
      runtime.nextSendAt = Date.now() + randDelayMs();
      runtime.onBreakUntil = null;
    }
    console.log(`[queue] ✅ أُرسلت إلى ${limits.maskPhone(job.phone)}`);
  } catch (err) {
    runtime.consecutiveFailures += 1;
    console.error(`[queue] فشل الإرسال إلى ${limits.maskPhone(job.phone)}:`, err.message);
    if (job.attempts >= 3) {
      markTerminal(job, "failed", err.message, applyTemplate(job.message, job.name));
    } else {
      job.status = "queued"; // إعادة المحاولة لاحقاً
      job.error = err.message;
    }
    runtime.nextSendAt = Date.now() + randDelayMs();

    // Circuit Breaker: 3 إخفاقات متتالية → إيقاف تلقائي
    if (runtime.consecutiveFailures >= CIRCUIT_BREAKER_FAILS) {
      runtime.paused = true;
      runtime.pauseReason = `توقف تلقائي: ${CIRCUIT_BREAKER_FAILS} إخفاقات متتالية`;
      if (io) io.emit("alert", {
        type: "circuit-breaker",
        message: `توقف الطابور تلقائياً بعد ${CIRCUIT_BREAKER_FAILS} إخفاقات متتالية. راجع السجل ثم استأنف يدوياً.`
      });
    }
  } finally {
    pruneHistory();
    saveQueue();
    emitUpdate();
    busy = false;
  }
}

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  setInterval(() => {
    tick().catch((e) => { busy = false; console.error("[queue] tick:", e.message); });
  }, 1000);
}

// ===== الحالة للواجهة =====
function getState() {
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const now = Date.now();
  const history = [...jobs]
    .filter((j) => j.status !== "queued" && j.status !== "sending")
    .slice(-50)
    .reverse()
    .map((j) => ({
      id: j.id,
      phone: limits.maskPhone(j.phone),
      name: j.name,
      preview: String(j.message).slice(0, 60),
      status: j.status,
      error: j.error,
      createdAt: j.createdAt,
      sentAt: j.sentAt
    }));
  const pending = queuedJobs.slice(0, 20).map((j, i) => ({
    id: j.id,
    position: i + 1,
    phone: limits.maskPhone(j.phone),
    name: j.name,
    preview: String(j.message).slice(0, 60),
    createdAt: j.createdAt
  }));
  return {
    paused: runtime.paused,
    pauseReason: runtime.pauseReason,
    emergency: runtime.emergency,
    queuedCount: queuedJobs.length,
    nextSendInSeconds: runtime.nextSendAt && runtime.nextSendAt > now
      ? Math.ceil((runtime.nextSendAt - now) / 1000) : 0,
    onLongBreak: !!(runtime.onBreakUntil && runtime.onBreakUntil > now),
    consecutiveFailures: runtime.consecutiveFailures,
    stats: limits.getStats(now),
    pending,
    history
  };
}

function emitUpdate() {
  if (io) io.emit("queue-update", getState());
}

module.exports = {
  setSocketIO,
  startLoop,
  enqueue,
  enqueueBulk,
  getState,
  emitUpdate,
  pause,
  resume,
  clear,
  emergencyStop,
  onConnectionDown,
  onConnectionUp,
  listOptout: loadOptout,
  addOptout,
  removeOptout,
  isOptedOut
};
