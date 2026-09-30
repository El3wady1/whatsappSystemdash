const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    // تغيير كلمة المرور بكود تأكيد
    pendingPasswordHash: { type: String, default: null },
    otpCodeHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Admin || mongoose.model("Admin", adminSchema);
