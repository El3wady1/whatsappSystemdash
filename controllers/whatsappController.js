const whatsapp = require("../services/whatsappService");
const queue = require("../services/queueService");
const limits = require("../services/limitsService");
const db = require("../services/dbService");

const STATUS_MESSAGES = {
  ready: "واتساب متصل",
  qr: "بانتظار مسح QR",
  authenticated: "تمت المصادقة... جاري التجهيز",
  connecting: "جاري الاتصال",
  auth_failure: "فشل المصادقة",
  disconnected: "غير متصل"
};

function maxLen() {
  return limits.config.maxMessageLength || 1000;
}

function getStatus(req, res) {
  const { status, connectingSince, loading, lastDisconnect } = whatsapp.getStatus();
  const q = queue.getState();
  return res.json({
    success: true,
    status,
    connectingSince: connectingSince || null,
    loading: loading || null,
    lastDisconnect: lastDisconnect || null,
    message: STATUS_MESSAGES[status] || status,
    db: db.isConnected(),
    queue: { queuedCount: q.queuedCount, paused: q.paused, nextSendInSeconds: q.nextSendInSeconds },
    stats: q.stats
  });
}

function validateSingle(phone, message) {
  if (!phone) throw new Error("رقم الجوال مطلوب.");
  const clean = whatsapp.cleanPhone(phone);
  if (!/^\d{7,15}$/.test(clean)) {
    throw new Error("رقم الجوال غير صالح (7 إلى 15 رقماً بالصيغة الدولية).");
  }
  const text = String(message || "").trim();
  if (!text) throw new Error("نص الرسالة مطلوب.");
  if (text.length > maxLen()) throw new Error(`تجاوزت الرسالة الحد الأقصى (${maxLen()} حرف).`);
  return { clean, text };
}

// POST /send — يضيف للطابور فقط، لا يرسل فوراً
function send(req, res) {
  try {
    if (!whatsapp.isReady()) {
      return res.status(400).json({ success: false, message: "واتساب غير متصل. امسح QR أولاً." });
    }
    const { phone, message, name, overrideCooldown } = req.body || {};
    const { clean, text } = validateSingle(phone, message);

    const r = queue.enqueue({
      phone: clean,
      message: text,
      name: name ? String(name).trim() : null,
      overrideCooldown: !!overrideCooldown,
      senderIp: req.ip
    });

    return res.json({
      success: true,
      message: `أُضيفت الرسالة للطابور (الموضع ${r.position} — الإرسال خلال ~${r.etaSeconds} ثانية حسب الفواصل).`,
      id: r.id,
      position: r.position,
      etaSeconds: r.etaSeconds
    });
  } catch (err) {
    console.error("[API send]", limits.maskPhone(req.body && req.body.phone), err.message);
    return res.status(400).json({ success: false, message: err.message || "تعذر إضافة الرسالة للطابور" });
  }
}

// POST /send-bulk — قالب واحد + اسم مخصص لكل مستقبل عبر {name}
// يقبل recipients كمصفوفة [{phone, name}] أو نص سطور "phone,name"
function sendBulk(req, res) {
  try {
    if (!whatsapp.isReady()) {
      return res.status(400).json({ success: false, message: "واتساب غير متصل. امسح QR أولاً." });
    }
    const { template, recipients, overrideCooldown } = req.body || {};
    const tpl = String(template || "").trim();
    if (!tpl) {
      return res.status(400).json({ success: false, message: "قالب الرسالة مطلوب (استخدم {name} للاسم)." });
    }
    if (tpl.length > maxLen()) {
      return res.status(400).json({ success: false, message: `تجاوز القالب الحد الأقصى (${maxLen()} حرف).` });
    }

    let list = [];
    if (Array.isArray(recipients)) {
      list = recipients;
    } else if (typeof recipients === "string") {
      list = recipients.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const idx = line.indexOf(",");
        if (idx === -1) return { phone: line.trim(), name: null };
        return { phone: line.slice(0, idx).trim(), name: line.slice(idx + 1).trim() || null };
      });
    }
    if (!list.length) {
      return res.status(400).json({ success: false, message: "أضف مستلماً واحداً على الأقل (رقم,اسم في كل سطر)." });
    }
    if (list.length > 50) {
      return res.status(400).json({ success: false, message: "الحد الأقصى 50 مستلماً في الدفعة الواحدة." });
    }

    const r = queue.enqueueBulk({
      template: tpl,
      recipients: list,
      overrideCooldown: !!overrideCooldown,
      senderIp: req.ip
    });

    return res.json({
      success: true,
      message: `أُضيف ${r.added.length} للطابور${r.failed.length ? ` — وتعذر ${r.failed.length}` : ""}. كل رسالة ستُخصص باسم صاحبها.`,
      added: r.added.length,
      failed: r.failed
    });
  } catch (err) {
    console.error("[API bulk]", err.message);
    return res.status(400).json({ success: false, message: err.message || "تعذر الإرسال الجماعي" });
  }
}

function getQueue(req, res) {
  return res.json({ success: true, ...queue.getState() });
}

// جلب QR الحالي عبر REST (احتياط إذا فات حدث الـ Socket)
function getQR(req, res) {
  const { status, qr } = whatsapp.getStatus();
  return res.json({ success: true, status, qr: qr || null });
}

function pauseQueue(req, res) {
  queue.pause("يدوي من اللوحة");
  return res.json({ success: true, message: "توقف الطابور مؤقتاً.", ...queue.getState() });
}

function resumeQueue(req, res) {
  if (!whatsapp.isReady()) {
    return res.status(400).json({ success: false, message: "واتساب غير متصل. لا يمكن الاستئناف." });
  }
  queue.resume();
  return res.json({ success: true, message: "استؤنف الطابور.", ...queue.getState() });
}

function clearQueue(req, res) {
  const r = queue.clear();
  return res.json({ success: true, message: `حُذفت ${r.cleared} رسالة معلقة من الطابور.`, ...queue.getState() });
}

function emergencyStop(req, res) {
  queue.emergencyStop();
  return res.json({ success: true, message: "⛔ توقف طارئ: أُوقف كل شيء فوراً.", ...queue.getState() });
}

// ===== سجل الرسائل (MongoDB) =====
async function getLogs(req, res) {
  if (!db.isConnected()) {
    return res.status(503).json({ success: false, db: false, message: "قاعدة البيانات غير متصلة." });
  }
  try {
    const { page, limit, status, search } = req.query || {};
    const data = await db.getLogs({ page, limit, status, search });
    const counts = await db.getLogCounts();
    return res.json({ success: true, db: true, ...data, counts });
  } catch (err) {
    return res.status(500).json({ success: false, message: "تعذر جلب السجل." });
  }
}

async function deleteLog(req, res) {
  if (!db.isConnected()) {
    return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة." });
  }
  const ok = await db.deleteLog(req.params.id);
  if (!ok) return res.status(404).json({ success: false, message: "السجل غير موجود." });
  return res.json({ success: true, message: "حُذف السجل." });
}

async function clearLogs(req, res) {
  if (!db.isConnected()) {
    return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة." });
  }
  const n = await db.clearLogs((req.query || {}).status);
  return res.json({ success: true, message: `حُذف ${n} سجل.`, deleted: n });
}

// ===== الإعدادات (MongoDB) =====
async function getSettings(req, res) {
  const stored = db.isConnected() ? await db.getSettings() : {};
  const values = { ...limits.config };
  for (const f of db.SETTINGS_SCHEMA) {
    if (f.key in stored) values[f.key] = stored[f.key];
  }
  return res.json({ success: true, db: db.isConnected(), schema: db.SETTINGS_SCHEMA, values });
}

async function updateSettings(req, res) {
  if (!db.isConnected()) {
    return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة — لا يمكن حفظ الإعدادات." });
  }
  try {
    const stored = await db.updateSettings(req.body || {});
    const values = { ...limits.config, ...stored };
    limits.updateConfig(values); // تفعيل فوري بدون إعادة تشغيل
    if (global._io) global._io.emit("queue-update", queue.getState());
    return res.json({ success: true, message: "حُفظت الإعدادات وطُبقت فوراً.", values });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
}

function listOptout(req, res) {
  const numbers = queue.listOptout().map(limits.maskPhone);
  return res.json({ success: true, count: numbers.length, numbers });
}

function addOptout(req, res) {
  const clean = whatsapp.cleanPhone((req.body || {}).phone);
  if (!/^\d{7,15}$/.test(clean)) {
    return res.status(400).json({ success: false, message: "رقم غير صالح." });
  }
  const list = queue.addOptout(clean, "manual");
  return res.json({ success: true, message: "أُضيف الرقم لقائمة الإيقاف.", count: list.length });
}

function removeOptout(req, res) {
  const raw = (req.params && req.params.phone) || ((req.body || {}).phone);
  const clean = whatsapp.cleanPhone(raw);
  const list = queue.listOptout();
  const target = list.find((n) => n === clean || limits.maskPhone(n) === String(raw));
  if (target) queue.removeOptout(target);
  return res.json({ success: true, message: "حُذف الرقم من قائمة الإيقاف.", count: queue.listOptout().length });
}

async function logout(req, res) {
  try {
    queue.pause("فصل الحساب");
    await whatsapp.logout();
    return res.json({ success: true, message: "تم فصل الحساب وحذف الجلسة. سيظهر QR جديد لربط حساب آخر." });
  } catch (err) {
    console.error("[API logout]", err.message);
    return res.status(500).json({ success: false, message: "تعذر فصل الحساب" });
  }
}

module.exports = {
  getStatus,
  send,
  sendBulk,
  getQueue,
  getQR,
  pauseQueue,
  resumeQueue,
  clearQueue,
  emergencyStop,
  getLogs,
  deleteLog,
  clearLogs,
  getSettings,
  updateSettings,
  listOptout,
  addOptout,
  removeOptout,
  logout
};
