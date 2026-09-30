const express = require("express");
const rateLimit = require("express-rate-limit");
const controller = require("../controllers/whatsappController");

const router = express.Router();

// حد صارم على الإضافة للطابور: 20 طلب / 15 دقيقة لكل IP
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "تجاوزت الحد المسموح (20 طلب / 15 دقيقة). الإضافة السريعة تعرض رقمك للحظر."
  }
});

router.get("/status", controller.getStatus);
router.get("/qr", controller.getQR);
router.post("/send", sendLimiter, controller.send);
router.post("/send-bulk", sendLimiter, controller.sendBulk);

router.get("/queue", controller.getQueue);
router.post("/queue/pause", controller.pauseQueue);
router.post("/queue/resume", controller.resumeQueue);
router.post("/queue/clear", controller.clearQueue);
router.post("/queue/stop", controller.emergencyStop);

router.get("/logs", controller.getLogs);
router.delete("/logs/:id", controller.deleteLog);
router.delete("/logs", controller.clearLogs);

router.get("/settings", controller.getSettings);
router.put("/settings", controller.updateSettings);

router.get("/optout", controller.listOptout);
router.post("/optout", controller.addOptout);
router.delete("/optout/:phone", controller.removeOptout);

router.post("/logout", controller.logout);

module.exports = router;
