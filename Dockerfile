# Use a lightweight Node.js base image
FROM node:18-slim

# Install Chromium and essential dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    fonts-liberation \
    ca-certificates \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer and production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=10000

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install production dependencies with fallback
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application code
COPY . .

# Optional: build frontend if needed
# WORKDIR /app/frontend
# RUN npm ci && npm run build:css
# RUN cp ./css/styles.css ../backend/css/styles.css

# Set backend working directory
WORKDIR /app/backend

# Expose port for Render
EXPOSE 10000

# Start the application
CMD ["npm", "start"]