// ===== إعدادات الاتصال (رابط الباك إند + التوكن محفوظان محلياً) =====
const store = {
  get apiBase() {
    const saved = localStorage.getItem("wa_apiBase");
    if (saved) return saved.replace(/\/$/, "");
    // افتراضي قابل للضبط من public/config.js (للداشبورد المنشورة منفصلة عن الباك إند)
    if (typeof window.__DEFAULT_API_BASE === "string" && window.__DEFAULT_API_BASE.trim()) {
      return window.__DEFAULT_API_BASE.trim().replace(/\/$/, "");
    }
    return window.location.origin.replace(/\/$/, "");
  },
  set apiBase(v) { localStorage.setItem("wa_apiBase", v.replace(/\/$/, "")); },
  get token() { return localStorage.getItem("wa_token") || ""; },
  set token(v) {
    if (v) localStorage.setItem("wa_token", v);
    else localStorage.removeItem("wa_token");
  }
};

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(store.apiBase + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(store.token ? { Authorization: "Bearer " + store.token } : {}),
        ...(options.headers || {})
      }
    });
  } catch (_) {
    const err = new Error("NETWORK");
    err.code = "NETWORK";
    throw err;
  }
  if (res.status === 401) {
    logoutToLogin();
    const err = new Error("انتهت الجلسة. سجل الدخول من جديد.");
    err.code = "UNAUTH";
    throw err;
  }
  if (!res.ok) {
    // نحافظ على رسالة السيرفر نفسها مع تصنيف الخطأ
    let msg = "خطأ " + res.status;
    try {
      const d = await res.json();
      if (d && d.message) msg = d.message;
    } catch (_) {}
    const err = new Error(msg);
    err.code = "HTTP";
    err.status = res.status;
    throw err;
  }
  return res;
}

// ===== Socket.IO =====
let socket = null;

function connectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
  socket = io(store.apiBase, { auth: { token: store.token } });

  socket.on("whatsapp-status", ({ status }) => setStatus(status));
  socket.on("whatsapp-qr", ({ qr }) => {
    if (qr) { flashNewQR(qr); qrWrapper.classList.remove("hidden"); }
    else qrImage.src = "";
  });
  socket.on("queue-update", (q) => renderQueue(q));
  socket.on("alert", ({ message }) => showAlert(message));
  socket.on("optout-added", ({ phone }) => {
    showAlert(`أُضيف ${phone} لقائمة الإيقاف تلقائياً (رد بكلمة إيقاف)`);
    loadOptout();
  });
  socket.onAny(() => { lastSocketMsg = Date.now(); });
  socket.on("connect_error", (err) => {
    if (err && err.message === "unauthorized") logoutToLogin();
  });
}

// ===== عناصر الدخول =====
const loginScreen = document.getElementById("loginScreen");
const dashboard = document.getElementById("dashboard");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginMsg = document.getElementById("loginMsg");

function showLoginMsg(ok, msg) {
  loginMsg.classList.remove("hidden", "success", "error");
  loginMsg.classList.add(ok ? "success" : "error");
  loginMsg.textContent = msg;
}

function showLogin() {
  dashboard.classList.add("hidden");
  loginScreen.classList.remove("hidden");
}

function logoutToLogin() {
  store.token = "";
  if (socket) { socket.disconnect(); socket = null; }
  showLogin();
}

async function enterDashboard(email) {
  loginScreen.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.getElementById("userChip").textContent = "👤 " + email;
  document.getElementById("apiBaseEdit").value = store.apiBase;
  renderApiCard();
  showView((window.location.hash || "#/home").replace("#/", ""));
  connectSocket();
  await refreshAll();
  pollFallback();
}

async function refreshAll() {
  try {
    const d = await (await apiFetch("/api/whatsapp/status")).json();
    setStatus(d.status);
    connectingSinceTs = d.connectingSince || 0;
    loadingPct = (d.loading && typeof d.loading.percent === "number") ? d.loading.percent : null;
    lastDrop = d.lastDisconnect || null;
    if (d.stats) renderQueue({ stats: d.stats, queuedCount: (d.queue && d.queue.queuedCount) || 0, pending: [], history: [] });
  } catch (_) { setStatus("disconnected"); }
  try {
    const q = await (await apiFetch("/api/whatsapp/queue")).json();
    if (q.success) renderQueue(q);
  } catch (_) {}
  loadLogs();
  loadSettings();
  loadOptout();
}

loginBtn.addEventListener("click", async () => {
  loginMsg.classList.add("hidden");
  if (!loginEmail.value.trim() || !loginPassword.value) {
    return showLoginMsg(false, "⚠️ أدخل الإيميل وكلمة المرور.");
  }
  loginBtn.disabled = true;
  try {
    const res = await fetch(store.apiBase + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value })
    });
    const data = await res.json();
    if (!data.success) return showLoginMsg(false, "❌ " + data.message);
    store.token = data.token;
    loginPassword.value = "";
    await enterDashboard(data.email);
  } catch (_) {
    showLoginMsg(false, "❌ تعذر الوصول للسيرفر. تحقق من الاتصال.");
  } finally {
    loginBtn.disabled = false;
  }
});
loginPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") loginBtn.click(); });

// ===== نسيت كلمة المرور (كود واتساب بدون دخول) =====
const forgotPane = document.getElementById("forgotPane");
const forgotStep2 = document.getElementById("forgotStep2");
const forgotMsg = document.getElementById("forgotMsg");

function forgotShow(ok, msg) {
  forgotMsg.classList.remove("hidden", "success", "error");
  forgotMsg.classList.add(ok ? "success" : "error");
  forgotMsg.textContent = msg;
}

document.getElementById("forgotLink").addEventListener("click", () => {
  forgotPane.classList.toggle("hidden");
  document.getElementById("forgotEmail").value = loginEmail.value;
  forgotStep2.classList.add("hidden");
  forgotMsg.classList.add("hidden");
});

document.getElementById("forgotReqBtn").addEventListener("click", async () => {
  forgotMsg.classList.add("hidden");
  const email = document.getElementById("forgotEmail").value.trim();
  if (!email) return forgotShow(false, "⚠️ أدخل الإيميل.");
  try {
    const res = await fetch(store.apiBase + "/api/auth/forgot/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!data.success) return forgotShow(false, "❌ " + data.message);
    forgotShow(true, "✅ " + data.message);
    forgotStep2.classList.remove("hidden");
  } catch (_) {
    forgotShow(false, "❌ تعذر الوصول للسيرفر.");
  }
});

document.getElementById("forgotConfirmBtn").addEventListener("click", async () => {
  forgotMsg.classList.add("hidden");
  const email = document.getElementById("forgotEmail").value.trim();
  const code = document.getElementById("forgotCode").value.trim();
  const newPassword = document.getElementById("forgotNewPw").value;
  if (!code || !newPassword) return forgotShow(false, "⚠️ أدخل الكود وكلمة المرور الجديدة.");
  try {
    const res = await fetch(store.apiBase + "/api/auth/forgot/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, newPassword })
    });
    const data = await res.json();
    if (!data.success) return forgotShow(false, "❌ " + data.message);
    forgotShow(true, data.message + " سجل الدخول الآن.");
  } catch (_) {
    forgotShow(false, "❌ تعذر الوصول للسيرفر.");
  }
});

// ===== بطاقة API للتطبيقات =====
const API_ENDPOINTS = [
  { m: "POST", p: "/api/auth/login", body: '{"email":"admin@example.com","password":"••••••"}', auth: false },
  { m: "GET", p: "/api/auth/me" },
  { m: "POST", p: "/api/auth/change-password/request", body: '{"newPassword":"NewPass123"}' },
  { m: "POST", p: "/api/auth/change-password/confirm", body: '{"code":"123456"}' },
  { m: "GET", p: "/api/whatsapp/status" },
  { m: "GET", p: "/api/whatsapp/qr" },
  { m: "POST", p: "/api/whatsapp/send", body: '{"phone":"9665XXXXXXXX","message":"مرحباً {name}","name":"محمد"}' },
  { m: "POST", p: "/api/whatsapp/send-bulk", body: '{"template":"مرحباً {name}","recipients":"9665...,محمد"}' },
  { m: "GET", p: "/api/whatsapp/queue" },
  { m: "POST", p: "/api/whatsapp/queue/pause" },
  { m: "POST", p: "/api/whatsapp/queue/resume" },
  { m: "POST", p: "/api/whatsapp/queue/clear" },
  { m: "POST", p: "/api/whatsapp/queue/stop" },
  { m: "GET", p: "/api/whatsapp/logs?page=1&limit=20" },
  { m: "DELETE", p: "/api/whatsapp/logs/<ID>" },
  { m: "DELETE", p: "/api/whatsapp/logs" },
  { m: "GET", p: "/api/whatsapp/settings" },
  { m: "PUT", p: "/api/whatsapp/settings", body: '{"maxPerDay":150}' },
  { m: "GET", p: "/api/whatsapp/optout" },
  { m: "POST", p: "/api/whatsapp/optout", body: '{"phone":"9665XXXXXXXX"}' },
  { m: "DELETE", p: "/api/whatsapp/optout/<phone>" },
  { m: "POST", p: "/api/whatsapp/logout" }
];

function copyText(t, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "تم ✅";
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  } else fallbackCopy(t, done);
}

function fallbackCopy(t, done) {
  const ta = document.createElement("textarea");
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (_) {}
  document.body.removeChild(ta);
}

function renderApiCard() {
  document.getElementById("apiBaseView").value = store.apiBase;
  document.getElementById("apiTokenView").value = store.token;
  const list = document.getElementById("apiList");
  list.innerHTML = API_ENDPOINTS.map((e, i) =>
    `<div class="api-row">` +
    `<div class="api-row-head"><span><span class="method ${e.m}">${e.m}</span>` +
    `<span class="api-url">${escapeHtml(store.apiBase + e.p)}</span></span>` +
    `<button class="btn btn-small" data-api-copy="${i}">نسخ الرابط</button></div>` +
    (e.body ? `<div class="api-body">${escapeHtml(e.body)}</div>` : "") +
    (e.auth === false ? `<div class="muted" style="font-size:.75rem">بدون توكن</div>` :
      `<div class="muted" style="font-size:.75rem">الهيدر: Authorization: Bearer TOKEN</div>`) +
    `</div>`
  ).join("");
  list.querySelectorAll("[data-api-copy]").forEach((b) => {
    b.addEventListener("click", () => {
      copyText(store.apiBase + API_ENDPOINTS[Number(b.dataset.apiCopy)].p, b);
    });
  });
}

document.querySelectorAll("[data-copy]").forEach((b) => {
  b.addEventListener("click", () => {
    copyText(document.getElementById(b.dataset.copy).value, b);
  });
});
document.getElementById("tokenShowBtn").addEventListener("click", (e) => {
  const inp = document.getElementById("apiTokenView");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  e.target.textContent = show ? "إخفاء" : "إظهار";
});

// خروج + تغيير رابط الباك إند
document.getElementById("logoutBtnTop").addEventListener("click", logoutToLogin);
document.getElementById("apiBaseSave").addEventListener("click", async () => {
  const v = document.getElementById("apiBaseEdit").value.trim().replace(/\/$/, "");
  if (!v) return;
  store.apiBase = v;
  showAlert("تم حفظ رابط الباك إند وإعادة الاتصال.");
  connectSocket();
  await refreshAll();
});

// ===== نافذة تغيير كلمة المرور =====
const pwModal = document.getElementById("pwModal");
const pwStep1 = document.getElementById("pwStep1");
const pwStep2 = document.getElementById("pwStep2");
const pwMsg = document.getElementById("pwMsg");

function pwShow(ok, msg) {
  pwMsg.classList.remove("hidden", "success", "error");
  pwMsg.classList.add(ok ? "success" : "error");
  pwMsg.textContent = msg;
}

document.getElementById("pwBtn").addEventListener("click", () => {
  pwStep1.classList.remove("hidden");
  pwStep2.classList.add("hidden");
  pwMsg.classList.add("hidden");
  document.getElementById("newPassword").value = "";
  document.getElementById("otpCode").value = "";
  pwModal.classList.remove("hidden");
});
document.getElementById("pwClose").addEventListener("click", () => pwModal.classList.add("hidden"));

document.getElementById("otpRequestBtn").addEventListener("click", async () => {
  pwMsg.classList.add("hidden");
  const np = document.getElementById("newPassword").value;
  if (!np || np.length < 6) return pwShow(false, "⚠️ كلمة المرور 6 أحرف على الأقل.");
  try {
    const res = await apiFetch("/api/auth/change-password/request", {
      method: "POST",
      body: JSON.stringify({ newPassword: np })
    });
    const data = await res.json();
    if (!data.success) return pwShow(false, "❌ " + data.message);
    document.getElementById("otpSentTo").textContent = "📩 " + data.message + " أدخل الكود (صالح 10 دقائق).";
    pwStep1.classList.add("hidden");
    pwStep2.classList.remove("hidden");
    pwShow(true, "✅ " + data.message);
  } catch (e) {
    pwShow(false, "❌ " + e.message);
  }
});

document.getElementById("otpConfirmBtn").addEventListener("click", async () => {
  pwMsg.classList.add("hidden");
  const code = document.getElementById("otpCode").value.trim();
  if (!code) return pwShow(false, "⚠️ أدخل الكود.");
  try {
    const res = await apiFetch("/api/auth/change-password/confirm", {
      method: "POST",
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!data.success) return pwShow(false, "❌ " + data.message);
    pwShow(true, data.message);
    setTimeout(() => { pwModal.classList.add("hidden"); logoutToLogin(); }, 2500);
  } catch (e) {
    pwShow(false, "❌ " + e.message);
  }
});

// ===== عناصر الاتصال =====
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const alertBox = document.getElementById("alertBox");
const qrWrapper = document.getElementById("qrWrapper");
const qrImage = document.getElementById("qrImage");
const connectedBox = document.getElementById("connectedBox");
const connectingBox = document.getElementById("connectingBox");
const logoutBtn = document.getElementById("logoutBtn");

// ===== عناصر الإرسال =====
const countryCode = document.getElementById("countryCode");
const phoneInput = document.getElementById("phoneInput");
const nameInput = document.getElementById("nameInput");
const messageInput = document.getElementById("messageInput");
const charCount = document.getElementById("charCount");
const overrideCooldown = document.getElementById("overrideCooldown");
const sendBtn = document.getElementById("sendBtn");
const loading = document.getElementById("loading");
const resultMsg = document.getElementById("resultMsg");

// ===== عناصر الطابور =====
const queuePaused = document.getElementById("queuePaused");
const statDay = document.getElementById("statDay");
const statHour = document.getElementById("statHour");
const statQueued = document.getElementById("statQueued");
const statNext = document.getElementById("statNext");
const barDay = document.getElementById("barDay");
const barHour = document.getElementById("barHour");
const warmupNote = document.getElementById("warmupNote");
const capWarn = document.getElementById("capWarn");
const pendingBody = document.getElementById("pendingBody");
const historyBody = document.getElementById("historyBody");

// ===== عناصر الإيقاف =====
const optoutInput = document.getElementById("optoutInput");
const optoutList = document.getElementById("optoutList");

let currentStatus = "disconnected";
let nextSendIn = 0;
let lastQueueState = null;
let lastSocketMsg = 0;
let connectingSinceTs = 0;
let lastQrAt = 0; // وقت وصول أحدث QR (صلاحيته ~20 ثانية)
let loadingPct = null; // نسبة تحميل واتساب ويب بعد المسح
let lastDrop = null; // { reason, at } — آخر انقطاع

// وميض يوضح أن هذا QR جديد — امسحه فوراً
function flashNewQR(src) {
  if (qrImage.src === src) return; // نفس الصورة، لا شيء جديد
  qrImage.src = src;
  lastQrAt = Date.now();
  qrImage.classList.remove("qr-fresh");
  void qrImage.offsetWidth;
  qrImage.classList.add("qr-fresh");
}

// ===== الراوتر الداخلي (تنقل بين الأقسام) =====
const VIEWS = ["home", "send", "queue", "logs", "settings", "api"];

function showView(name) {
  if (!VIEWS.includes(name)) name = "home";
  VIEWS.forEach((v) => {
    const el = document.getElementById("view-" + v);
    if (el) el.classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll(".nav-link").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  if (window.location.hash !== "#/" + name) {
    history.replaceState(null, "", "#/" + name);
  }
  if (name === "logs") loadLogs();
  if (name === "queue") {
    apiFetch("/api/whatsapp/queue")
      .then((r) => r.json())
      .then((q) => { if (q.success) renderQueue(q); })
      .catch(() => {});
  }
}

const STATUS_LABEL = {
  ready: "🟢 متصل",
  connecting: "🟡 جاري الاتصال",
  authenticated: "🟡 تمت المصادقة...",
  qr: "🟡 بانتظار مسح QR",
  auth_failure: "🔴 فشل المصادقة",
  disconnected: "🔴 غير متصل"
};

const PILL = { sent: "تم الإرسال", failed: "فشل", skipped: "تُجاوز" };

function setStatus(status) {
  currentStatus = status;
  statusText.textContent = STATUS_LABEL[status] || status;
  statusBadge.className = "badge " + (
    status === "ready" ? "connected" :
    status === "disconnected" || status === "auth_failure" ? "disconnected" : "connecting"
  );
  const ready = status === "ready";
  sendBtn.disabled = !ready;
  const bulkBtn = document.getElementById("bulkBtn");
  if (bulkBtn) bulkBtn.disabled = !ready;
  qrWrapper.classList.toggle("hidden", status !== "qr");
  connectedBox.classList.toggle("hidden", !ready);
  connectingBox.classList.toggle("hidden", status !== "connecting" && status !== "authenticated");
  // زر تسجيل الخروج ظاهر دائماً (يعمل حتى بدون اتصال — يمسح الجلسة ويولّد QR جديد)
  if (status === "ready") qrImage.src = "";
}

function showResult(ok, msg) {
  resultMsg.classList.remove("hidden", "success", "error");
  resultMsg.classList.add(ok ? "success" : "error");
  resultMsg.textContent = msg;
}

function showAlert(msg) {
  alertBox.textContent = "⚠️ " + msg;
  alertBox.classList.remove("hidden");
  setTimeout(() => alertBox.classList.add("hidden"), 12000);
}

function fmtCountdown(s) {
  if (!s || s <= 0) return "—";
  if (s < 60) return s + " ث";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " د " + (s % 60) + " ث";
  return Math.floor(m / 60) + " س " + (m % 60) + " د";
}

function barClass(pct) {
  return pct >= 100 ? "bar-fill full" : pct >= 80 ? "bar-fill hot" : "bar-fill";
}

function renderQueue(q) {
  lastQueueState = q;
  const nqc = document.getElementById("navQueueCount");
  if (nqc) {
    if (q.queuedCount > 0) { nqc.textContent = q.queuedCount; nqc.classList.remove("hidden"); }
    else nqc.classList.add("hidden");
  }
  const s = q.stats || {};
  statDay.textContent = `${s.sentDay || 0} / ${s.capDay || 0}`;
  statHour.textContent = `${s.sentHour || 0} / ${s.capHour || 0}`;
  statQueued.textContent = q.queuedCount || 0;
  nextSendIn = q.nextSendInSeconds || 0;
  statNext.textContent = fmtCountdown(nextSendIn) + (q.onLongBreak ? " (استراحة)" : "");
  barDay.style.width = Math.min(100, s.pctDay || 0) + "%";
  barDay.className = barClass(s.pctDay || 0);
  barHour.style.width = Math.min(100, s.pctHour || 0) + "%";
  barHour.className = barClass(s.pctHour || 0);

  if (s.warmup && s.warmup.enabled && s.warmup.phase !== "normal") {
    const phases = { "warmup-1": "الأولى (سقف 20/يوم)", "warmup-2": "الثانية (سقف 50/يوم)", "warmup-3": "الثالثة (سقف 100/يوم)" };
    warmupNote.textContent = `🔥 وضع التسخين — اليوم ${s.warmup.day} — المرحلة ${phases[s.warmup.phase] || s.warmup.phase}`;
  } else if (s.warmup && !s.warmup.enabled) {
    warmupNote.textContent = "";
  } else {
    warmupNote.textContent = "✅ انتهت فترة التسخين — السقف الطبيعي مطبق";
  }
  if (!(s.allowedHours && s.allowedHours.now)) {
    warmupNote.textContent += ` ⏸ خارج ساعات الإرسال (${s.allowedHours ? s.allowedHours.start : 9}–${s.allowedHours ? s.allowedHours.end : 21})`;
  }

  const pct = Math.max(s.pctDay || 0, s.pctHour || 0);
  if (pct >= 80) {
    capWarn.textContent = `⚠️ تنبيه: وصلت إلى ${pct}% من السقف. خفف الإرسال لتفادي الحظر.`;
    capWarn.classList.remove("hidden");
  } else {
    capWarn.classList.add("hidden");
  }

  if (q.paused || q.emergency) {
    queuePaused.textContent = (q.emergency ? "⛔ إيقاف طارئ نشط. " : "⏸ الطابور متوقف. ") + (q.pauseReason || "");
    queuePaused.classList.remove("hidden");
  } else {
    queuePaused.classList.add("hidden");
  }

  if (q.pending && q.pending.length) {
    pendingBody.innerHTML = q.pending.map((p) =>
      `<tr><td>${p.position}</td><td>${p.phone}</td><td>${p.name || "—"}</td><td>${escapeHtml(p.preview)}</td></tr>`
    ).join("");
  } else {
    pendingBody.innerHTML = '<tr><td colspan="4" class="muted">لا توجد رسائل معلقة</td></tr>';
  }

  if (q.history && q.history.length) {
    historyBody.innerHTML = q.history.map((h) =>
      `<tr><td>${h.phone}</td><td>${escapeHtml(h.preview)}</td>` +
      `<td><span class="pill ${h.status}">${PILL[h.status] || h.status}</span></td>` +
      `<td>${escapeHtml(h.error || "—")}</td></tr>`
    ).join("");
  } else {
    historyBody.innerHTML = '<tr><td colspan="4" class="muted">لا يوجد سجل بعد</td></tr>';
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

setInterval(() => {
  if (nextSendIn > 0) {
    nextSendIn--;
    statNext.textContent = fmtCountdown(nextSendIn);
  }
  // عدّاد مدة الاتصال + نسبة التحميل بعد المسح
  const cEl = document.getElementById("connectingText");
  if (cEl && (currentStatus === "connecting" || currentStatus === "authenticated")) {
    if (loadingPct !== null && currentStatus === "authenticated") {
      cEl.textContent = `تم المسح ✅ جارٍ تحميل واتساب ${loadingPct}% — أبقِ التطبيق مفتوحاً على الجوال`;
    } else if (connectingSinceTs) {
      const s = Math.max(0, Math.floor((Date.now() - connectingSinceTs) / 1000));
      cEl.textContent = `جاري الاتصال بواتساب... (منذ ${s} ث) — أول اتصال بعد النشر/الاستيقاظ قد يستغرق 1-3 دقائق، وإذا تجاوز 5 دقائق راجع سجلات السيرفر`;
    } else {
      cEl.textContent = "جاري الاتصال بواتساب...";
    }
  }
  // عدّاد عمر QR الحالي (ينتهي خلال ~20 ثانية)
  const ageEl = document.getElementById("qrAge");
  if (ageEl && !qrWrapper.classList.contains("hidden") && lastQrAt) {
    const age = Math.floor((Date.now() - lastQrAt) / 1000);
    ageEl.textContent = age < 20
      ? `🟢 صالح للمسح الآن (منذ ${age} ث) — امسح بسرعة`
      : `🟡 انتهت صلاحية هذا الكود على الأرجح — انتظر الجديد`;
  } else if (ageEl) {
    ageEl.textContent = "";
  }
  // عرض سبب آخر انقطاع (دائم الظهور إلا عند الاتصال المستقر)
  const dropEl = document.getElementById("lastDrop");
  if (dropEl) {
    if (lastDrop && currentStatus !== "ready") {
      const ago = Math.max(0, Math.floor((Date.now() - lastDrop.at) / 1000));
      dropEl.textContent = `⚠️ آخر انقطاع (منذ ${ago} ث): ${lastDrop.reason}`;
    } else {
      dropEl.textContent = "";
    }
  }
}, 1000);

// ===== احتياط: تحديث الحالة وQR عبر REST كل 5 ثوانٍ (يعمل حتى لو تعطل الـ Socket) =====
function setSrvText(msg, cls) {
  const el = document.getElementById("srvState");
  if (!el) return;
  el.textContent = msg;
  el.className = "srv-state " + cls;
}

function setSrvState(ok, live) {
  if (ok) {
    setSrvText(
      live ? "🟢 السيرفر متصل • تحديث لحظي" : "🟡 السيرفر متصل • التحديث يدوي بزر 🔄",
      live ? "ok" : "warn"
    );
  } else {
    setSrvText(
      `🔴 السيرفر لا يرد (${store.apiBase}) — قد يكون نائماً، انتظر دقيقة واضغط 🔄 تحديث`,
      "err"
    );
  }
}

async function pollFallback() {
  if (dashboard.classList.contains("hidden") || document.hidden) return;
  try {
    const d = await (await apiFetch("/api/whatsapp/status")).json();
    if (d.success) setStatus(d.status);
    connectingSinceTs = (d && d.connectingSince) || 0;
    loadingPct = (d && d.loading && typeof d.loading.percent === "number") ? d.loading.percent : null;
    lastDrop = (d && d.lastDisconnect) || null;
    const live = !!socket && socket.connected && (Date.now() - lastSocketMsg < 15000);
    setSrvState(true, live);
    try {
      const q = await (await apiFetch("/api/whatsapp/qr")).json();
      if (q.qr) {
        flashNewQR(q.qr);
        qrWrapper.classList.remove("hidden");
      } else if (d.status === "ready") {
        qrImage.src = "";
      }
    } catch (_) {}
  } catch (e) {
    if (e && e.code === "HTTP" && e.status === 404) {
      setSrvText(`🔴 الرابط الحالي لا يشير للباك إند (404) — ضع رابط سيرفر الباك في شريط 🔗 بالرئيسية. الرابط الحالي: ${store.apiBase}`, "err");
    } else if (e && e.code === "HTTP") {
      setSrvText(`🔴 الباك يرد بخطأ (${e.status}: ${e.message}) — راجع سجلات Render`, "err");
    } else {
      setSrvState(false, false);
    }
  }
}

// زر التحديث اليدوي (لا يوجد تحديث تلقائي — التحديث اللحظي يصل عبر Socket فقط)
const refreshAllBtn = document.getElementById("refreshAllBtn");
if (refreshAllBtn) {
  refreshAllBtn.addEventListener("click", async () => {
    refreshAllBtn.disabled = true;
    try {
      await refreshAll();
      await pollFallback();
    } finally {
      refreshAllBtn.disabled = false;
    }
  });
}

// ===== عداد الأحرف =====
messageInput.addEventListener("input", () => {
  charCount.textContent = messageInput.value.length;
});

// ===== إضافة للطابور =====
sendBtn.addEventListener("click", async () => {
  resultMsg.classList.add("hidden");
  const code = countryCode.value.replace(/\D/g, "");
  const number = phoneInput.value.replace(/[\s+\-()]/g, "");
  const message = messageInput.value.trim();
  const name = nameInput.value.trim();

  if (!number) return showResult(false, "⚠️ أدخل رقم الجوال.");
  if (!/^\d{5,15}$/.test(number) || !/^\d{7,15}$/.test(code + number)) {
    return showResult(false, "⚠️ رقم الجوال غير صالح.");
  }
  if (!message) return showResult(false, "⚠️ اكتب نص الرسالة أولاً.");

  sendBtn.disabled = true;
  loading.classList.remove("hidden");
  try {
    const res = await apiFetch("/api/whatsapp/send", {
      method: "POST",
      body: JSON.stringify({
        phone: code + number, message, name: name || undefined,
        overrideCooldown: overrideCooldown.checked
      })
    });
    const data = await res.json();
    showResult(data.success, (data.success ? "✅ " : "❌ ") + data.message);
    if (data.success) {
      messageInput.value = "";
      charCount.textContent = "0";
      const q = await (await apiFetch("/api/whatsapp/queue")).json();
      if (q.success) renderQueue(q);
    }
  } catch (e) {
    showResult(false, "❌ " + e.message);
  } finally {
    loading.classList.add("hidden");
    if (currentStatus === "ready") sendBtn.disabled = false;
  }
});

// ===== تبويب مفرد / جماعي =====
const tabSingle = document.getElementById("tabSingle");
const tabBulk = document.getElementById("tabBulk");
const singlePane = document.getElementById("singlePane");
const bulkPane = document.getElementById("bulkPane");
tabSingle.addEventListener("click", () => {
  tabSingle.classList.add("active"); tabBulk.classList.remove("active");
  singlePane.classList.remove("hidden"); bulkPane.classList.add("hidden");
});
tabBulk.addEventListener("click", () => {
  tabBulk.classList.add("active"); tabSingle.classList.remove("active");
  bulkPane.classList.remove("hidden"); singlePane.classList.add("hidden");
});

// ===== الإرسال الجماعي بأسماء مخصصة =====
const bulkTemplate = document.getElementById("bulkTemplate");
const bulkList = document.getElementById("bulkList");
const bulkCharCount = document.getElementById("bulkCharCount");
const bulkBtn = document.getElementById("bulkBtn");
bulkTemplate.addEventListener("input", () => { bulkCharCount.textContent = bulkTemplate.value.length; });

bulkBtn.addEventListener("click", async () => {
  resultMsg.classList.add("hidden");
  const template = bulkTemplate.value.trim();
  const lines = bulkList.value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!template) return showResult(false, "⚠️ اكتب قالب الرسالة أولاً (استخدم {name} للاسم).");
  if (!lines.length) return showResult(false, "⚠️ أضف مستلماً واحداً على الأقل بصيغة: الرقم,الاسم.");
  bulkBtn.disabled = true;
  loading.classList.remove("hidden");
  try {
    const res = await apiFetch("/api/whatsapp/send-bulk", {
      method: "POST",
      body: JSON.stringify({
        template,
        recipients: lines.join("\n"),
        overrideCooldown: document.getElementById("bulkOverride").checked
      })
    });
    const data = await res.json();
    showResult(data.success, (data.success ? "✅ " : "❌ ") + data.message);
    if (data.success && data.failed && data.failed.length) {
      showResult(true, "✅ " + data.message + " | تعذر: " + data.failed.map((f) => f.phone).join("، "));
    }
    if (data.success) { bulkList.value = ""; loadLogs(); }
  } catch (e) {
    showResult(false, "❌ " + e.message);
  } finally {
    loading.classList.add("hidden");
    if (currentStatus === "ready") bulkBtn.disabled = false;
  }
});

// ===== أزرار الطابور =====
async function queueAction(path, okMsg) {
  try {
    const res = await apiFetch(path, { method: "POST" });
    const data = await res.json();
    if (data.success) renderQueue(data);
    showResult(data.success, (data.success ? "✅ " : "❌ ") + (okMsg || data.message));
  } catch (e) {
    showResult(false, "❌ " + e.message);
  }
}

document.getElementById("pauseBtn").addEventListener("click", () => queueAction("/api/whatsapp/queue/pause"));
document.getElementById("resumeBtn").addEventListener("click", () => queueAction("/api/whatsapp/queue/resume"));
document.getElementById("clearBtn").addEventListener("click", () => {
  if (confirm("حذف كل الرسائل المعلقة من الطابور؟")) queueAction("/api/whatsapp/queue/clear");
});
document.getElementById("stopBtn").addEventListener("click", () => {
  if (confirm("⛔ إيقاف طارئ؟ سيتوقف كل شيء فوراً.")) queueAction("/api/whatsapp/queue/stop");
});

// ===== فصل حساب واتساب =====
logoutBtn.addEventListener("click", async () => {
  if (!confirm("فصل حساب واتساب وحذف الجلسة وربط حساب آخر؟")) return;
  try {
    const res = await apiFetch("/api/whatsapp/logout", { method: "POST" });
    const data = await res.json();
    showResult(data.success, (data.success ? "✅ " : "❌ ") + data.message);
  } catch (e) {
    showResult(false, "❌ " + e.message);
  }
});

// ===== قائمة الإيقاف =====
async function loadOptout() {
  try {
    const res = await apiFetch("/api/whatsapp/optout");
    const data = await res.json();
    if (!data.numbers || !data.numbers.length) {
      optoutList.innerHTML = '<li class="muted">القائمة فارغة</li>';
      return;
    }
    optoutList.innerHTML = data.numbers.map((n) =>
      `<li><span>${n}</span><button data-phone="${n}">حذف</button></li>`
    ).join("");
    optoutList.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", async () => {
        await apiFetch("/api/whatsapp/optout/" + encodeURIComponent(b.dataset.phone), { method: "DELETE" });
        loadOptout();
      });
    });
  } catch (_) {
    optoutList.innerHTML = '<li class="muted">تعذر التحميل</li>';
  }
}

document.getElementById("optoutAddBtn").addEventListener("click", async () => {
  const v = optoutInput.value.replace(/[\s+\-()]/g, "");
  if (!v) return;
  await apiFetch("/api/whatsapp/optout", {
    method: "POST",
    body: JSON.stringify({ phone: v })
  });
  optoutInput.value = "";
  loadOptout();
});
document.getElementById("optoutRefreshBtn").addEventListener("click", loadOptout);

// ===== سجل الرسائل (MongoDB) =====
const dbBadge = document.getElementById("dbBadge");
const logsBody = document.getElementById("logsBody");
const logFilter = document.getElementById("logFilter");
const logSearch = document.getElementById("logSearch");
const logPage = document.getElementById("logPage");
let logPageNum = 1, logPages = 1;

function fmtTime(t) {
  if (!t) return "—";
  return new Date(t).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

async function loadLogs() {
  try {
    const q = new URLSearchParams({
      page: logPageNum, limit: 20,
      status: logFilter.value, search: logSearch.value.trim()
    });
    const res = await apiFetch("/api/whatsapp/logs?" + q.toString());
    const data = await res.json();
    if (!data.success) {
      dbBadge.textContent = "DB: غير متصل";
      dbBadge.className = "db-badge off";
      logsBody.innerHTML = '<tr><td colspan="6" class="muted">قاعدة البيانات غير متصلة — أضف MONGODB_URI في .env</td></tr>';
      return;
    }
    dbBadge.textContent = "DB: متصل ✅";
    dbBadge.className = "db-badge on";
    document.getElementById("logTotal").textContent = (data.counts && data.counts.totalSent) || 0;
    document.getElementById("logToday").textContent = (data.counts && data.counts.todaySent) || 0;
    document.getElementById("logFailed").textContent = (data.counts && data.counts.totalFailed) || 0;
    logPages = data.pages || 1;
    logPage.textContent = `صفحة ${data.page} / ${logPages}`;
    if (!data.logs.length) {
      logsBody.innerHTML = '<tr><td colspan="6" class="muted">لا توجد سجلات مطابقة</td></tr>';
      return;
    }
    logsBody.innerHTML = data.logs.map((l) =>
      `<tr><td>${escapeHtml(l.phone)}</td><td>${escapeHtml(l.name || "—")}</td>` +
      `<td>${escapeHtml((l.finalMessage || l.message || "").slice(0, 80))}</td>` +
      `<td><span class="pill ${l.status}">${PILL[l.status] || l.status}</span></td>` +
      `<td>${fmtTime(l.sentAt || l.createdAt)}</td>` +
      `<td><button class="del-btn" data-id="${l._id}">حذف</button></td></tr>`
    ).join("");
    logsBody.querySelectorAll(".del-btn").forEach((b) => {
      b.addEventListener("click", async () => {
        if (!confirm("حذف هذا السجل؟")) return;
        await apiFetch("/api/whatsapp/logs/" + b.dataset.id, { method: "DELETE" });
        loadLogs();
      });
    });
  } catch (e) {
    logsBody.innerHTML = `<tr><td colspan="6" class="muted">تعذر التحميل: ${escapeHtml(e.message || "")}</td></tr>`;
  }
}

document.getElementById("logRefreshBtn").addEventListener("click", () => { logPageNum = 1; loadLogs(); });
document.getElementById("logPrev").addEventListener("click", () => {
  if (logPageNum > 1) { logPageNum--; loadLogs(); }
});
document.getElementById("logNext").addEventListener("click", () => {
  if (logPageNum < logPages) { logPageNum++; loadLogs(); }
});
document.getElementById("logClearBtn").addEventListener("click", async () => {
  const st = logFilter.value;
  if (!confirm(st ? `مسح كل سجلات الحالة (${st})؟` : "مسح كل السجل؟")) return;
  await apiFetch("/api/whatsapp/logs" + (st ? "?status=" + st : ""), { method: "DELETE" });
  logPageNum = 1;
  loadLogs();
});
let logTimer = null;
logSearch.addEventListener("input", () => {
  clearTimeout(logTimer);
  logTimer = setTimeout(() => { logPageNum = 1; loadLogs(); }, 500);
});
logFilter.addEventListener("change", () => { logPageNum = 1; loadLogs(); });

// ===== الإعدادات (MongoDB) =====
const settingsForm = document.getElementById("settingsForm");
const settingsMsg = document.getElementById("settingsMsg");

async function loadSettings() {
  try {
    const res = await apiFetch("/api/whatsapp/settings");
    const data = await res.json();
    settingsForm.innerHTML = data.schema.map((f) => {
      const v = data.values[f.key];
      if (f.type === "boolean") {
        return `<label class="set-item"><span>${f.label}</span>` +
          `<input type="checkbox" data-key="${f.key}" ${v ? "checked" : ""} /></label>`;
      }
      return `<label class="set-item"><span>${f.label}</span>` +
        `<input type="number" class="input" data-key="${f.key}" value="${v}" min="${f.min}" max="${f.max}" /></label>`;
    }).join("");
  } catch (_) {
    settingsForm.innerHTML = '<p class="muted">تعذر تحميل الإعدادات</p>';
  }
}

document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
  const patch = {};
  settingsForm.querySelectorAll("[data-key]").forEach((el) => {
    patch[el.dataset.key] = el.type === "checkbox" ? el.checked : Number(el.value);
  });
  try {
    const res = await apiFetch("/api/whatsapp/settings", {
      method: "PUT",
      body: JSON.stringify(patch)
    });
    const data = await res.json();
    settingsMsg.classList.remove("hidden", "success", "error");
    settingsMsg.classList.add(data.success ? "success" : "error");
    settingsMsg.textContent = (data.success ? "✅ " : "❌ ") + data.message;
    if (data.success) loadSettings();
  } catch (e) {
    settingsMsg.classList.remove("hidden");
    settingsMsg.classList.add("error");
    settingsMsg.textContent = "❌ " + e.message;
  }
});

// توفير الموارد: إيقاف الاتصال والتحديثات عند إخفاء التبويب
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (socket) socket.disconnect();
  } else if (!dashboard.classList.contains("hidden") && store.token) {
    connectSocket();
    pollFallback();
  }
});

// ===== الإقلاع =====
(function initNav() {
  document.querySelectorAll(".nav-link").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });
  window.addEventListener("hashchange", () => {
    if (!dashboard.classList.contains("hidden")) {
      showView(window.location.hash.replace("#/", ""));
    }
  });
  // إجراءات سريعة (الرئيسية)
  document.getElementById("quickSend").addEventListener("click", () => showView("send"));
  document.getElementById("quickLogs").addEventListener("click", () => showView("logs"));
  document.getElementById("quickToggle").addEventListener("click", async () => {
    const path = (lastQueueState && (lastQueueState.paused || lastQueueState.emergency))
      ? "/api/whatsapp/queue/resume"
      : "/api/whatsapp/queue/pause";
    try {
      const data = await (await apiFetch(path, { method: "POST" })).json();
      if (data.success) renderQueue(data);
      showAlert(data.message);
    } catch (e) {
      showAlert(e.message);
    }
  });
})();

(async function boot() {
  if (!store.token) return showLogin();
  try {
    const res = await apiFetch("/api/auth/me");
    const data = await res.json();
    if (data.success) return enterDashboard(data.email);
  } catch (_) {}
  showLogin();
})();
