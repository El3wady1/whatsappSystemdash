const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ===== الإعدادات من .env (يمكن تجاوزها من MongoDB عبر updateConfig) =====
const config = {
  maxPerHour: parseInt(process.env.MAX_PER_HOUR || "30", 10),
  maxPerDay: parseInt(process.env.MAX_PER_DAY || "150", 10),
  warmupEnabled: (process.env.WARMUP_ENABLED || "true").toLowerCase() === "true",
  allowedStart: parseInt(process.env.ALLOWED_HOURS_START || "9", 10),
  allowedEnd: parseInt(process.env.ALLOWED_HOURS_END || "21", 10),
  timezone: process.env.TIMEZONE || "Asia/Riyadh",
  recipientCooldownHours: parseFloat(process.env.PER_RECIPIENT_COOLDOWN_HOURS || "24"),
  maxSameTextPerHour: parseInt(process.env.MAX_SAME_TEXT_PER_HOUR || "10", 10),
  maxMessageLength: parseInt(process.env.MAX_MESSAGE_LENGTH || process.env.MAX_MESSAGE_LENGTH || "1000", 10),
  minDelayS: parseInt(process.env.MIN_DELAY_SECONDS || "8", 10),
  maxDelayS: parseInt(process.env.MAX_DELAY_SECONDS || "25", 10),
  breakEveryMin: parseInt(process.env.LONG_BREAK_EVERY_MIN || "10", 10),
  breakEveryMax: parseInt(process.env.LONG_BREAK_EVERY_MAX || "15", 10),
  breakMinS: parseInt(process.env.LONG_BREAK_MIN_SECONDS || "120", 10),
  breakMaxS: parseInt(process.env.LONG_BREAK_MAX_SECONDS || "300", 10),
  typingMinMs: parseInt(process.env.TYPING_MIN_MS || "2000", 10),
  typingMaxMs: parseInt(process.env.TYPING_MAX_MS || "6000", 10)
};

// تطبيق إعدادات قادمة من MongoDB (تتجاوز .env أثناء التشغيل)
function updateConfig(patch = {}) {
  const allowed = Object.keys(config);
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (typeof config[k] === "boolean") {
      config[k] = v === true || v === "true";
    } else if (typeof v === "number" && Number.isFinite(v)) {
      config[k] = v;
    }
  }
  return { ...config };
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStats() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATS_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      return {
        warmupStart: s.warmupStart || null,
        sentLog: Array.isArray(s.sentLog) ? s.sentLog : [],
        recipientMap: s.recipientMap || {},
        textLog: Array.isArray(s.textLog) ? s.textLog : []
      };
    }
  } catch (_) {}
  return { warmupStart: null, sentLog: [], recipientMap: {}, textLog: [] };
}

let stats = loadStats();

function saveStats() {
  try {
    ensureDataDir();
    // تقليص السجلات حتى لا يكبر الملف
    stats.sentLog = stats.sentLog.slice(-1000);
    stats.textLog = stats.textLog.slice(-500);
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) {
    console.error("[limits] تعذر حفظ stats.json:", e.message);
  }
}

// ===== أدوات الخصوصية =====
function hashPhone(phone) {
  return crypto.createHash("sha256").update(String(phone)).digest("hex").slice(0, 16);
}

// إخفاء آخر 4 أرقام في اللوجات والواجهة
function maskPhone(phone) {
  const p = String(phone || "");
  if (p.length <= 4) return "****";
  return p.slice(0, -4) + "****";
}

// ===== الوقت بتوقيت المنطقة المحددة =====
function hourInTz(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric", hour12: false, timeZone: config.timezone
    });
    return parseInt(fmt.format(date), 10) % 24;
  } catch (_) {
    return date.getHours();
  }
}

function isWithinAllowedHours(date = new Date()) {
  const h = hourInTz(date);
  return h >= config.allowedStart && h < config.allowedEnd;
}

// أقرب بداية مسموحة قادمة (timestamp) — تقريبي ويكفي لمنطقة بلا DST مثل الرياض
function nextAllowedStartTs(now = Date.now()) {
  const h = hourInTz(new Date(now));
  let diffHours;
  if (h < config.allowedStart) diffHours = config.allowedStart - h;
  else diffHours = 24 - h + config.allowedStart;
  return now + diffHours * 3600 * 1000;
}

// ===== التسخين =====
function ensureWarmupStart() {
  if (!stats.warmupStart) {
    stats.warmupStart = new Date().toISOString();
    saveStats();
    console.log("[limits] بدء فترة التسخين:", stats.warmupStart);
  }
}

function warmupDayIndex(now = Date.now()) {
  if (!config.warmupEnabled || !stats.warmupStart) return Infinity;
  return Math.floor((now - new Date(stats.warmupStart).getTime()) / 86400000);
}

// اليوم 1-3: 20 / اليوم 4-7: 50 / الأسبوع الثاني: 100 / ثم الطبيعي
function getEffectiveCaps(now = Date.now()) {
  let perDay = config.maxPerDay;
  let phase = "normal";
  let day = null;
  if (config.warmupEnabled) {
    ensureWarmupStart();
    const d = warmupDayIndex(now);
    day = d + 1;
    if (d <= 2) { perDay = Math.min(perDay, 20); phase = "warmup-1"; }
    else if (d <= 6) { perDay = Math.min(perDay, 50); phase = "warmup-2"; }
    else if (d <= 13) { perDay = Math.min(perDay, 100); phase = "warmup-3"; }
  }
  return { perHour: config.maxPerHour, perDay, phase, day };
}

function countSentSince(ms, now = Date.now()) {
  const from = now - ms;
  return stats.sentLog.filter((e) => e.at >= from).length;
}

function checkCanSend(now = Date.now()) {
  if (!isWithinAllowedHours(new Date(now))) {
    return { ok: false, reason: "hours", waitUntil: nextAllowedStartTs(now) };
  }
  const caps = getEffectiveCaps(now);
  const sentHour = countSentSince(3600 * 1000, now);
  if (sentHour >= caps.perHour) {
    return { ok: false, reason: "hour", waitUntil: now + 5 * 60 * 1000 };
  }
  const sentDay = countSentSince(24 * 3600 * 1000, now);
  if (sentDay >= caps.perDay) {
    return { ok: false, reason: "day", waitUntil: now + 30 * 60 * 1000 };
  }
  return { ok: true };
}

function recordSent(phone, text, now = Date.now()) {
  stats.sentLog.push({ at: now, to: hashPhone(phone) });
  stats.recipientMap[hashPhone(phone)] = now;
  const th = crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
  stats.textLog.push({ at: now, hash: th });
  saveStats();
}

function sameTextCountLastHour(text, now = Date.now()) {
  const th = crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
  return stats.textLog.filter((e) => e.at >= now - 3600 * 1000 && e.hash === th).length;
}

function recipientCooldownRemaining(phone, now = Date.now()) {
  const last = stats.recipientMap[hashPhone(phone)] || 0;
  const remain = config.recipientCooldownHours * 3600 * 1000 - (now - last);
  return remain > 0 ? remain : 0;
}

function getStats(now = Date.now()) {
  const caps = getEffectiveCaps(now);
  const sentHour = countSentSince(3600 * 1000, now);
  const sentDay = countSentSince(24 * 3600 * 1000, now);
  return {
    sentHour, sentDay,
    capHour: caps.perHour, capDay: caps.perDay,
    pctHour: caps.perHour ? Math.round((sentHour / caps.perHour) * 100) : 0,
    pctDay: caps.perDay ? Math.round((sentDay / caps.perDay) * 100) : 0,
    warmup: { enabled: config.warmupEnabled, phase: caps.phase, day: caps.day },
    allowedHours: {
      start: config.allowedStart, end: config.allowedEnd,
      timezone: config.timezone, now: isWithinAllowedHours(new Date(now))
    },
    recipientCooldownHours: config.recipientCooldownHours
  };
}

module.exports = {
  config,
  updateConfig,
  ensureWarmupStart,
  getEffectiveCaps,
  checkCanSend,
  recordSent,
  sameTextCountLastHour,
  recipientCooldownRemaining,
  getStats,
  isWithinAllowedHours,
  nextAllowedStartTs,
  hourInTz,
  maskPhone,
  hashPhone
};
