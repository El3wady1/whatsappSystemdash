# 📲 WhatsApp Dashboard (واجهة فقط)

واجهة لوحة إرسال واتساب — HTML + CSS + JavaScript. تُستضاف كملفات ثابتة (Static Site)
وتتصل بسيرفر الباك إند عبر الرابط المضبوط في `config.js`.

## ⚙️ الربط بالباك إند

افتح `config.js` وضع رابط سيرفر الباك إند:

```js
window.__DEFAULT_API_BASE = "https://your-backend.onrender.com";
```

أو من داخل اللوحة بعد الدخول: شريط 🔗 الباك إند في الرئيسية (يُحفظ في المتصفح).

## 🚀 النشر على Render (Static Site)

1. ارفع هذا الريبو على Render كـ **Static Site**.
2. Build Command: فارغ (لا يوجد بناء).
3. Publish Directory: `.` (جذر الريبو).
4. افتح رابط الموقع وسجل الدخول بإيميل المدير.

## 🔥 النشر على Firebase Hosting (بديل ممتاز)

أسرع CDN ولا ينام أبداً:

```bash
npm install -g firebase-tools
firebase login
# أنشئ مشروعاً من console.firebase.google.com ثم:
firebase use --add
firebase deploy
```

ملف `firebase.json` جاهز في الريبو (النشر من جذر المجلد، و`config.js` بدون كاش
ليصلك تحديث رابط الباك إند فوراً).

## 🔌 المتطلبات من جهة الباك إند

- أن يكون سيرفر الباك إند (ريبو `whatsappSystemBE`) يعمل ومتاحاً برابط HTTPS.
- CORS مفتوح في الباك إند (مضبوط مسبقاً).
- رابط الـ Socket.IO يُحمّل من CDN — لا حاجة لأي إعداد إضافي.

## ⏰ منع نوم السيرفر المجاني (مهم لمسح QR بسرعة)

سيرفرات Render المجانية تنام بعد 15 دقيقة خمول، فأول فتح يستغرق دقيقة
ويكون QR المعروض قد انتهت صلاحيته. الحل: ping مجاني كل 5 دقائق يُبقيه مستيقظاً:

1. سجل في [UptimeRobot](https://uptimerobot.com) (مجاني) أو [cron-job.org](https://cron-job.org).
2. أضف Monitor من نوع **HTTP(s)** على الرابط:
   `https://your-backend.onrender.com/health`
3. الفترة: كل **5 دقائق**.
4. النتيجة: السيرفر لا ينام → الـ QR يظهر فوراً والمسح من أول مرة.
