FROM node:20-slim

# Installer Chromium og alle nødvendige avhengigheter
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-dejavu \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Fortell Puppeteer å bruke systemets Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
