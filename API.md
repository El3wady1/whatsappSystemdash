# 📡 API Endpoints — انسخ واستخدم مباشرة

> كل مسارات `/api/whatsapp/*` محمية — أضف الهيدر:
> `Authorization: Bearer <TOKEN>`
>
> ```bash
> BASE="http://localhost:4001"   # أو رابط سيرفرك المرفوع
>
> # 1) تسجيل الدخول مرة واحدة وأخذ التوكن
> TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
>   -H "Content-Type: application/json" \
>   -d '{"email":"admin@example.com","password":"ChangeMe123"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
>
> # ثم استخدمه في كل طلب:
> AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
> ```

## 🔐 الدخول والحساب (بدون حماية للدخول فقط)

```bash
# تسجيل الدخول
curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"ChangeMe123"}'
# → {"success":true,"token":"...","email":"..."}

# بياناتي (تحتاج توكن)
curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN"

# الخطوة 1: طلب تغيير كلمة المرور (يُرسل كود واتساب لرقم المدير)
curl -s -X POST "$BASE/api/auth/change-password/request" \
  "${AUTH[@]}" \
  -d '{"newPassword":"NewPass123"}'

# الخطوة 2: تأكيد الكود وتفعيل الباسورد الجديد
curl -s -X POST "$BASE/api/auth/change-password/confirm" \
  "${AUTH[@]}" \
  -d '{"code":"123456"}'

# نسيت كلمة المرور (بدون دخول — الكود يصل واتساب رقم المدير)
curl -s -X POST "$BASE/api/auth/forgot/request" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com"}'

curl -s -X POST "$BASE/api/auth/forgot/confirm" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","code":"123456","newPassword":"NewPass123"}'
```

## 📲 واتساب — الحالة والإرسال

```bash
# حالة الاتصال + ملخص الطابور + الإحصائيات
curl -s "$BASE/api/whatsapp/status" -H "Authorization: Bearer $TOKEN"

# جلب QR الحالي مباشرة (احتياط لو فات حدث الـ Socket)
curl -s "$BASE/api/whatsapp/qr" -H "Authorization: Bearer $TOKEN"

# إضافة رسالة واحدة للطابور (تدعم {name})
curl -s -X POST "$BASE/api/whatsapp/send" \
  "${AUTH[@]}" \
  -d '{"phone":"966501234567","message":"مرحباً {name}","name":"محمد"}'

# إرسال جماعي بأسماء مخصصة (حتى 50 — سطور: رقم,اسم)
curl -s -X POST "$BASE/api/whatsapp/send-bulk" \
  "${AUTH[@]}" \
  -d '{"template":"مرحباً {name} 🌟","recipients":"966501234567,محمد\n966509876543,سارة"}'

# فصل الحساب وحذف الجلسة (يولّد QR جديد)
curl -s -X POST "$BASE/api/whatsapp/logout" -H "Authorization: Bearer $TOKEN"
```

## 📦 الطابور

```bash
# حالة الطابور (المعلقة + آخر 50 + الإحصائيات)
curl -s "$BASE/api/whatsapp/queue" -H "Authorization: Bearer $TOKEN"

# إيقاف مؤقت / استئناف / مسح المعلقة / إيقاف طارئ
curl -s -X POST "$BASE/api/whatsapp/queue/pause"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/api/whatsapp/queue/resume" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/api/whatsapp/queue/clear"  -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/api/whatsapp/queue/stop"   -H "Authorization: Bearer $TOKEN"
```

## 📊 سجل الرسائل (MongoDB)

```bash
# السجل مع بحث وفلترة وصفحات
curl -s "$BASE/api/whatsapp/logs?page=1&limit=20&status=sent&search=محمد" \
  -H "Authorization: Bearer $TOKEN"

# حذف سجل واحد
curl -s -X DELETE "$BASE/api/whatsapp/logs/<ID>" -H "Authorization: Bearer $TOKEN"

# مسح السجل (كله أو حسب الحالة: ?status=sent)
curl -s -X DELETE "$BASE/api/whatsapp/logs" -H "Authorization: Bearer $TOKEN"
```

## ⚙️ الإعدادات (MongoDB — تُطبق فوراً)

```bash
# عرض الإعدادات
curl -s "$BASE/api/whatsapp/settings" -H "Authorization: Bearer $TOKEN"

# تحديث (مثال: السقف اليومي + الفواصل)
curl -s -X PUT "$BASE/api/whatsapp/settings" \
  "${AUTH[@]}" \
  -d '{"maxPerDay":150,"minDelayS":8,"maxDelayS":25,"maxPerHour":30}'
```

## 🚫 قائمة الإيقاف

```bash
curl -s "$BASE/api/whatsapp/optout" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$BASE/api/whatsapp/optout" "${AUTH[@]}" -d '{"phone":"966500000001"}'
curl -s -X DELETE "$BASE/api/whatsapp/optout/966500000001" -H "Authorization: Bearer $TOKEN"
```

## 🔌 Socket.IO (تحديث لحظي)

```js
import { io } from "socket.io-client";
const socket = io(BASE, { auth: { token: TOKEN } });
socket.on("whatsapp-status", ({ status }) => {}); // ready | qr | connecting | ...
socket.on("whatsapp-qr", ({ qr }) => {});         // صورة QR كـ DataURL
socket.on("queue-update", (state) => {});         // الطابور والإحصائيات
socket.on("alert", ({ message }) => {});          // تنبيهات (توقف تلقائي...)
socket.on("optout-added", ({ phone }) => {});     // إضافة تلقائية للإيقاف
```

## 🩺 فحص عام (بدون توكن)

```bash
curl -s "$BASE/health"   # → {"ok":true,"db":true}
```
