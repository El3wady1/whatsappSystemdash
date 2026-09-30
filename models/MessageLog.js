const mongoose = require("mongoose");

const messageLogSchema = new mongoose.Schema(
  {
    jobId: { type: String, index: true },
    phone: { type: String, required: true, index: true }, // الرقم الكامل (لوحة تحكم خاصة)
    name: { type: String, default: null },
    message: { type: String, required: true }, // النص الأصلي قبل تعبئة {name}
    finalMessage: { type: String, default: null }, // النص المرسل فعلياً بعد التخصيص
    status: {
      type: String,
      enum: ["queued", "sending", "sent", "failed", "skipped"],
      default: "queued",
      index: true
    },
    error: { type: String, default: null },
    senderIp: { type: String, default: null }, // مين أرسل (IP صاحب الطلب)
    sentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

messageLogSchema.index({ createdAt: -1 });

module.exports = mongoose.models.MessageLog || mongoose.model("MessageLog", messageLogSchema);
