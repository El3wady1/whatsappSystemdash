const express = require("express");
const rateLimit = require("express-rate-limit");
const auth = require("../services/authService");
const queue = require("../services/queueService");
const whatsapp = require("../services/whatsappService");
const db = require("../services/dbService");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "محاولات كثيرة. حاول بعد 15 دقيقة." }
});

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "تجاوزت طلبات الأكواد. حاول بعد ساعة." }
});

// حد صارم لاستعادة كلمة المرور (عامة — بدون دخول)
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "تجاوزت طلبات الاستعادة. حاول بعد ساعة." }
});

async function enqueueOtp(req, to, msg) {
  queue.enqueue({
    phone: to,
    message: msg,
    name: null,
    overrideCooldown: true,
    priority: true, // أول الطابور
    senderIp: req.ip
  });
}

// POST /api/auth/login {email, password}
router.post("/login", loginLimiter, async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة." });
    }
    const { email, password } = req.body || {};
    const r = await auth.login(email, password);
    return res.json({ success: true, message: "تم تسجيل الدخول.", ...r });
  } catch (err) {
    return res.status(401).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  return res.json({ success: true, email: req.admin.email });
});

// POST /api/auth/change-password/request {newPassword}
router.post("/change-password/request", requireAuth, otpLimiter, async (req, res) => {
  try {
    if (!whatsapp.isReady()) {
      return res.status(400).json({ success: false, message: "واتساب غير متصل — لا يمكن إرسال كود التأكيد." });
    }
    const { newPassword } = req.body || {};
    const r = await auth.requestPasswordChange(req.admin.sub, newPassword, (to, msg) => enqueueOtp(req, to, msg));
    return res.json({ success: true, message: `أُرسل كود التأكيد واتساب إلى ${r.sentTo}.`, sentTo: r.sentTo });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/auth/change-password/confirm {code}
router.post("/change-password/confirm", requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    await auth.confirmPasswordChange(req.admin.sub, code);
    return res.json({ success: true, message: "✅ تم تغيير كلمة المرور. سجل الدخول بها من جديد." });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/auth/forgot/request {email} — عام (الكود يصل واتساب المدير فقط)
router.post("/forgot/request", forgotLimiter, async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة." });
    }
    if (!whatsapp.isReady()) {
      return res.status(400).json({ success: false, message: "واتساب غير متصل — لا يمكن إرسال الكود الآن." });
    }
    const { email } = req.body || {};
    const r = await auth.forgotRequest(email, (to, msg) => enqueueOtp(req, to, msg));
    return res.json({
      success: true,
      message: r.sent
        ? `أُرسل كود الاستعادة واتساب إلى ${r.sentTo}.`
        : "إذا كان الإيميل مسجلاً سيصلك الكود واتساب على رقم المدير."
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/auth/forgot/confirm {email, code, newPassword} — عام
router.post("/forgot/confirm", forgotLimiter, async (req, res) => {
  try {
    if (!db.isConnected()) {
      return res.status(503).json({ success: false, message: "قاعدة البيانات غير متصلة." });
    }
    const { email, code, newPassword } = req.body || {};
    await auth.forgotConfirm(email, code, newPassword);
    return res.json({ success: true, message: "✅ تم تعيين كلمة المرور الجديدة. سجل الدخول بها." });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
