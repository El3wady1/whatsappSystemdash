require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const { Server } = require("socket.io");

const whatsapp = require("./services/whatsappService");
const queue = require("./services/queueService");
const limits = require("./services/limitsService");
const db = require("./services/dbService");
const authService = require("./services/authService");
const whatsappRoutes = require("./routes/whatsappRoutes");
const authRoutes = require("./routes/authRoutes");
const { requireAuth } = require("./middleware/auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }
});
global._io = io;

const PORT = process.env.PORT || 4001;

// ===== Middlewares =====
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ===== Routes (كل مسارات الواتساب محمية بتسجيل الدخول) =====
app.use("/api/auth", authRoutes);
app.use("/api/whatsapp", requireAuth, whatsappRoutes);
app.get("/health", (req, res) => res.json({ ok: true, db: db.isConnected() }));

// ===== ربط الخدمات ببعضها =====
whatsapp.setSocketIO(io);
queue.setSocketIO(io);
whatsapp.setHooks({
  onReady: () => queue.onConnectionUp(),
  onDown: (reason) => queue.onConnectionDown(reason),
  onOptoutKeyword: (phone) => queue.addOptout(phone, "reply")
});

io.use((socket, next) => {
  const token = (socket.handshake.auth && socket.handshake.auth.token) || null;
  if (token && authService.verifyToken(token)) return next();
  next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  const state = whatsapp.getStatus();
  socket.emit("whatsapp-status", { status: state.status });
  if (state.qr) socket.emit("whatsapp-qr", { qr: state.qr });
  socket.emit("queue-update", queue.getState());
});

// ===== Start =====
queue.startLoop();
server.listen(PORT, async () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);

  // MongoDB: الإعدادات + سجل الرسائل + حساب المدير
  const ok = await db.connect();
  if (ok) {
    try {
      await authService.initAdmin();
      const stored = await db.getSettings();
      if (Object.keys(stored).length) {
        limits.updateConfig(stored);
        console.log("[db] طُبقت الإعدادات المحفوظة من MongoDB");
      }
    } catch (e) {
      console.error("[db] تعذر تحميل الإعدادات:", e.message);
    }
  }

  whatsapp.initialize().catch((e) => console.error("WhatsApp init:", e.message));
});

process.on("SIGINT", () => { console.log("\nإيقاف السيرفر..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\nإيقاف السيرفر..."); process.exit(0); });
