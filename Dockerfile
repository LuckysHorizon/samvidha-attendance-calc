# Use Node.js 18
FROM node:18-slim

# Install Puppeteer dependencies and Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg2 \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    libu2f-udev \
    libvulkan1 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list && \
    apt-get update && apt-get install -y google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# Puppeteer config
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome \
    CHROME_BIN=/usr/bin/google-chrome \
    NODE_ENV=production

# Set working directory
WORKDIR /app

# Copy only package files first (to cache layer)
COPY backend/package.json backend/package-lock.json ./backend/

# Install backend dependencies
WORKDIR /app/backend
RUN npm ci --only=production

# Go back to app root and copy full code
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend

# (Optional) Build frontend if needed
# WORKDIR /app/frontend
# RUN npm ci && npm run build:css
# RUN cp ./css/styles.css ../backend/css/styles.css

# Final workdir
WORKDIR /app/backend

# Expose port
EXPOSE 3000

# Start app
CMD ["npm", "start"]
