const { verifyToken } = require("../services/authService");

// حماية مسارات API — يتطلب Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ success: false, message: "غير مصرح. سجل الدخول أولاً." });
  }
  req.admin = payload;
  next();
}

module.exports = { requireAuth };
