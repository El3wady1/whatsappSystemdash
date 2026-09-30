# whatsapp-web-sender — Docker
FROM node:20-slim

# اعتماديات Chromium على Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    HEADLESS=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_OPTIONS=--max-old-space-size=256

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# مجلدات التشغيل (تُربط بـ volumes للحفاظ على الجلسة والطابور)
RUN mkdir -p .wwebjs_auth .wwebjs_cache data

EXPOSE 4001
CMD ["node", "server.js"]
