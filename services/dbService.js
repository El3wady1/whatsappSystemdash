const mongoose = require("mongoose");
const Setting = require("../models/Setting");
const MessageLog = require("../models/MessageLog");

// ===== تعريف الإعدادات القابلة للتحرير من اللوحة =====
const SETTINGS_SCHEMA = [
  { key: "maxPerHour", label: "الحد الأقصى في الساعة", type: "number", min: 1, max: 100 },
  { key: "maxPerDay", label: "الحد الأقصى في اليوم", type: "number", min: 1, max: 500 },
  { key: "minDelayS", label: "أقل فاصل بين الرسائل (ثانية)", type: "number", min: 3, max: 120 },
  { key: "maxDelayS", label: "أطول فاصل بين الرسائل (ثانية)", type: "number", min: 5, max: 300 },
  { key: "breakEveryMin", label: "استراحة طويلة كل N رسالة (من)", type: "number", min: 5, max: 50 },
  { key: "breakEveryMax", label: "(إلى)", type: "number", min: 5, max: 100 },
  { key: "breakMinS", label: "مدة الاستراحة بالثواني (من)", type: "number", min: 30, max: 900 },
  { key: "breakMaxS", label: "(إلى)", type: "number", min: 60, max: 1800 },
  { key: "allowedStart", label: "بداية ساعات الإرسال (24h)", type: "number", min: 0, max: 23 },
  { key: "allowedEnd", label: "نهاية ساعات الإرسال (24h)", type: "number", min: 1, max: 24 },
  { key: "recipientCooldownHours", label: "منع تكرار نفس الرقم (ساعة)", type: "number", min: 0, max: 168 },
  { key: "maxSameTextPerHour", label: "منع تكرار نفس النص (عدد/ساعة)", type: "number", min: 1, max: 100 },
  { key: "maxMessageLength", label: "أقصى طول للرسالة (حرف)", type: "number", min: 100, max: 2000 },
  { key: "typingMinMs", label: "مدة «يكتب...» بالمللي (من)", type: "number", min: 500, max: 15000 },
  { key: "typingMaxMs", label: "(إلى)", type: "number", min: 500, max: 15000 },
  { key: "warmupEnabled", label: "تفعيل وضع التسخين للأرقام الجديدة", type: "boolean" }
];

let connected = false;

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] لا يوجد MONGODB_URI — العمل بدون قاعدة بيانات (الطابور JSON فقط).");
    return false;
  }
  try {
    await mongoose.connect(uri, {
      dbName: "whatsapp_sender",
      serverSelectionTimeoutMS: 10000
    });
    connected = true;
    console.log("[db] ✅ متصل بـ MongoDB");
    return true;
  } catch (err) {
    console.error("[db] تعذر الاتصال بـ MongoDB:", err.message);
    console.error("[db] سيعمل النظام بدون سجل دائم. تحقق من الرابط و IP whitelist في Atlas.");
    return false;
  }
}

mongoose.connection.on("disconnected", () => {
  if (connected) console.warn("[db] انقطع الاتصال بـ MongoDB — إعادة المحاولة تلقائياً...");
  connected = false;
});
mongoose.connection.on("reconnected", () => {
  connected = true;
  console.log("[db] ✅ أُعيد الاتصال بـ MongoDB");
});

// ===== الإعدادات =====
async function getSettings() {
  const out = {};
  if (!isConnected()) return out;
  try {
    const docs = await Setting.find({}).lean();
    docs.forEach((d) => { out[d.key] = d.value; });
  } catch (_) {}
  return out;
}

function validateSettings(patch) {
  const clean = {};
  for (const field of SETTINGS_SCHEMA) {
    if (!(field.key in patch)) continue;
    let v = patch[field.key];
    if (field.type === "boolean") {
      clean[field.key] = v === true || v === "true" || v === 1;
    } else {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`قيمة غير صالحة لـ ${field.label}`);
      clean[field.key] = Math.min(field.max, Math.max(field.min, v));
    }
  }
  // فحوصات منطقية
  const g = (k, fb) => (k in clean ? clean[k] : fb);
  if (g("maxDelayS", 25) < g("minDelayS", 8)) throw new Error("أطول فاصل يجب أن يكون ≥ أقل فاصل");
  if (g("allowedEnd", 21) <= g("allowedStart", 9)) throw new Error("نهاية ساعات الإرسال يجب أن تكون بعد البداية");
  if (g("breakEveryMax", 15) < g("breakEveryMin", 10)) throw new Error("نهاية نطاق الاستراحة يجب أن تكون ≥ بدايته");
  if (g("breakMaxS", 300) < g("breakMinS", 120)) throw new Error("أطول استراحة يجب أن تكون ≥ أقصر استراحة");
  if (g("typingMaxMs", 6000) < g("typingMinMs", 2000)) throw new Error("أطول مدة كتابة يجب أن تكون ≥ أقصر مدة");
  return clean;
}

async function updateSettings(patch) {
  const clean = validateSettings(patch);
  for (const [key, value] of Object.entries(clean)) {
    await Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true });
  }
  return getSettings();
}

// ===== سجل الرسائل =====
async function logMessage(doc) {
  if (!isConnected()) return null;
  try {
    return await MessageLog.create(doc);
  } catch (e) {
    console.error("[db] تعذر حفظ السجل:", e.message);
    return null;
  }
}

async function getLogs({ page = 1, limit = 20, status, search } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const filter = {};
  if (status && ["sent", "failed", "skipped", "queued", "sending"].includes(status)) {
    filter.status = status;
  }
  if (search) {
    const s = String(search).trim();
    filter.$or = [{ phone: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }, { name: new RegExp(s, "i") }];
  }
  const [total, logs] = await Promise.all([
    MessageLog.countDocuments(filter),
    MessageLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
  ]);
  return { total, page, limit, pages: Math.ceil(total / limit) || 1, logs };
}

async function getLogCounts() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [totalSent, todaySent, totalFailed] = await Promise.all([
    MessageLog.countDocuments({ status: "sent" }),
    MessageLog.countDocuments({ status: "sent", createdAt: { $gte: startOfDay } }),
    MessageLog.countDocuments({ status: "failed" })
  ]);
  return { totalSent, todaySent, totalFailed };
}

async function deleteLog(id) {
  const r = await MessageLog.findByIdAndDelete(id);
  return !!r;
}

async function clearLogs(status) {
  const filter = {};
  if (status && ["sent", "failed", "skipped"].includes(status)) filter.status = status;
  const r = await MessageLog.deleteMany(filter);
  return r.deletedCount || 0;
}

module.exports = {
  SETTINGS_SCHEMA,
  connect,
  isConnected,
  getSettings,
  updateSettings,
  validateSettings,
  logMessage,
  getLogs,
  getLogCounts,
  deleteLog,
  clearLogs
};
