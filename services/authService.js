const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Admin = require("../models/Admin");

function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  console.warn("[auth] ⚠️ لا يوجد JWT_SECRET — تُستخدم نسخة مؤقتة (التوكن يُلغى عند إعادة التشغيل).");
  if (!global._jwtTmp) global._jwtTmp = crypto.randomBytes(32).toString("hex");
  return global._jwtTmp;
}

// إنشاء حساب المدير من .env عند أول تشغيل
async function initAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.warn("[auth] لم تُضبط ADMIN_EMAIL/ADMIN_PASSWORD — لن يعمل الدخول حتى تضبطهما وتعيد التشغيل.");
    return null;
  }
  let admin = await Admin.findOne({ email });
  if (!admin) {
    admin = await Admin.create({
      email,
      passwordHash: await bcrypt.hash(password, 12)
    });
    console.log(`[auth] ✅ أُنشئ حساب المدير: ${email}`);
  }
  return admin;
}

async function login(email, password) {
  const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim() });
  if (!admin) throw new Error("بيانات الدخول غير صحيحة.");
  const ok = await bcrypt.compare(String(password || ""), admin.passwordHash);
  if (!ok) throw new Error("بيانات الدخول غير صحيحة.");
  const token = jwt.sign({ sub: admin._id.toString(), email: admin.email }, jwtSecret(), {
    expiresIn: "7d"
  });
  return { token, email: admin.email };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret());
  } catch (_) {
    return null;
  }
}

// تطبيع رقم التنبيه: 0599417209 ← 966599417209
function normalizeNotifyNumber(raw) {
  let p = String(raw || "").replace(/[\s+\-()]/g, "");
  if (/^0\d{9}$/.test(p)) p = "966" + p.slice(1);
  if (!/^\d{7,15}$/.test(p)) throw new Error("رقم التنبيه ADMIN_NOTIFY_NUMBER غير صالح.");
  return p;
}

function makeOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 أرقام
}

function hashCode(code) {
  return crypto.createHash("sha256").update("otp:" + code).digest("hex");
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

// الخطوة 1: طلب تغيير الباسورد → إرسال كود واتساب لرقم المدير
async function requestPasswordChange(adminId, newPassword, sendOtpFn) {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.");
  }
  const admin = await Admin.findById(adminId);
  if (!admin) throw new Error("الحساب غير موجود.");

  const code = makeOtp();
  admin.pendingPasswordHash = await bcrypt.hash(String(newPassword), 12);
  admin.otpCodeHash = hashCode(code);
  admin.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  admin.otpAttempts = 0;
  await admin.save();

  const to = normalizeNotifyNumber(process.env.ADMIN_NOTIFY_NUMBER || "0599417209");
  const msg = `🔐 كود تأكيد تغيير كلمة المرور: ${code}\nصالح لمدة 10 دقائق. إذا لم تطلب ذلك تجاهل الرسالة.`;
  await sendOtpFn(to, msg); // يُرسل عبر طابور واتساب بأولوية
  return { sentTo: to.replace(/(\d{6})\d+(\d{2})/, "$1****$2") };
}

// الخطوة 2: تأكيد الكود → تفعيل الباسورد الجديد
async function confirmPasswordChange(adminId, code) {
  const admin = await Admin.findById(adminId);
  if (!admin || !admin.otpCodeHash || !admin.pendingPasswordHash) {
    throw new Error("لا يوجد طلب تغيير معلق. اطلب كوداً جديداً.");
  }
  if (admin.otpExpiresAt < new Date()) {
    admin.pendingPasswordHash = null;
    admin.otpCodeHash = null;
    await admin.save();
    throw new Error("انتهت صلاحية الكود. اطلب كوداً جديداً.");
  }
  if (admin.otpAttempts >= OTP_MAX_ATTEMPTS) {
    admin.pendingPasswordHash = null;
    admin.otpCodeHash = null;
    await admin.save();
    throw new Error("تجاوزت المحاولات. اطلب كوداً جديداً.");
  }
  if (hashCode(String(code || "").trim()) !== admin.otpCodeHash) {
    admin.otpAttempts += 1;
    await admin.save();
    throw new Error(`الكود غير صحيح. (المحاولة ${admin.otpAttempts}/${OTP_MAX_ATTEMPTS})`);
  }
  admin.passwordHash = admin.pendingPasswordHash;
  admin.pendingPasswordHash = null;
  admin.otpCodeHash = null;
  admin.otpExpiresAt = null;
  admin.otpAttempts = 0;
  await admin.save();
  return true;
}

// ===== نسيت كلمة المرور (بدون تسجيل دخول — الكود يصل واتساب المدير فقط) =====
async function forgotRequest(email, sendOtpFn) {
  const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim() });
  // رد موحد حتى لا يُكشف وجود الإيميل — لكن لا نرسل شيئاً إذا غير موجود
  if (!admin) return { sent: false };
  const code = makeOtp();
  admin.pendingPasswordHash = null; // كلمة المرور الجديدة تُستلم مع التأكيد
  admin.otpCodeHash = hashCode(code);
  admin.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  admin.otpAttempts = 0;
  await admin.save();

  const to = normalizeNotifyNumber(process.env.ADMIN_NOTIFY_NUMBER || "0599417209");
  await sendOtpFn(to, `🔐 كود استعادة كلمة المرور: ${code}\nصالح لمدة 10 دقائق. إذا لم تطلب ذلك تجاهل الرسالة.`);
  return { sent: true, sentTo: to.replace(/(\d{6})\d+(\d{2})/, "$1****$2") };
}

async function forgotConfirm(email, code, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.");
  }
  const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim() });
  if (!admin || !admin.otpCodeHash) {
    throw new Error("لا يوجد طلب استعادة. اطلب كوداً جديداً.");
  }
  if (admin.otpExpiresAt < new Date()) {
    admin.otpCodeHash = null;
    await admin.save();
    throw new Error("انتهت صلاحية الكود. اطلب كوداً جديداً.");
  }
  if (admin.otpAttempts >= OTP_MAX_ATTEMPTS) {
    admin.otpCodeHash = null;
    await admin.save();
    throw new Error("تجاوزت المحاولات. اطلب كوداً جديداً.");
  }
  if (hashCode(String(code || "").trim()) !== admin.otpCodeHash) {
    admin.otpAttempts += 1;
    await admin.save();
    throw new Error(`الكود غير صحيح. (المحاولة ${admin.otpAttempts}/${OTP_MAX_ATTEMPTS})`);
  }
  admin.passwordHash = await bcrypt.hash(String(newPassword), 12);
  admin.pendingPasswordHash = null;
  admin.otpCodeHash = null;
  admin.otpExpiresAt = null;
  admin.otpAttempts = 0;
  await admin.save();
  return true;
}

module.exports = {
  initAdmin,
  login,
  verifyToken,
  requestPasswordChange,
  confirmPasswordChange,
  forgotRequest,
  forgotConfirm
};
