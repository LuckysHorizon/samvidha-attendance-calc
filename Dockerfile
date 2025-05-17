# Build stage
FROM node:18-slim AS builder

WORKDIR /usr/src/app

# Install only the necessary Chrome dependencies with optimized layer caching
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && wget --quiet https://raw.githubusercontent.com/vishnubob/wait-for-it/master/wait-for-it.sh -O /usr/sbin/wait-for-it.sh \
    && chmod +x /usr/sbin/wait-for-it.sh

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source code
COPY . .

# Production stage
FROM node:18-slim

WORKDIR /usr/src/app

# Create necessary directories with proper permissions
RUN mkdir -p /usr/src/app && \
    chown -R node:node /usr/src/app

# Install Chrome dependencies with optimized layer caching
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    google-chrome-stable \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && wget --quiet https://raw.githubusercontent.com/vishnubob/wait-for-it/master/wait-for-it.sh -O /usr/sbin/wait-for-it.sh \
    && chmod +x /usr/sbin/wait-for-it.sh

# Copy only necessary files from builder
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/package*.json ./
COPY --from=builder --chown=node:node /usr/src/app/backend ./backend
COPY --from=builder --chown=node:node /usr/src/app/frontend ./frontend

# Set environment variables for better performance
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV CHROME_BIN=/usr/bin/google-chrome
ENV NODE_OPTIONS="--max-old-space-size=512"
ENV BROWSER_POOL_MAX=2
ENV BROWSER_POOL_MIN=1
ENV CACHE_TTL=3600
ENV CACHE_MAX_KEYS=1000

# Switch to non-root user
USER node

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Expose port
EXPOSE ${PORT:-3000}

# Start the application with PM2 in cluster mode
CMD ["node", "backend/server.js"]
