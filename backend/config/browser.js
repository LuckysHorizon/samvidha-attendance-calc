const puppeteer = require('puppeteer');
const genericPool = require('generic-pool');
const os = require('os');

// Dynamic pool sizing based on available system resources
const calculatePoolSize = () => {
  const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
  const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);
  const cpuCount = os.cpus().length;
  
  // Allocate pool size based on available resources
  // Each Chrome instance typically uses 200-300MB RAM
  const maxByMemory = Math.floor(freeMemoryGB / 0.5); // Allow 500MB per instance
  const maxByCPU = Math.max(1, cpuCount - 1); // Leave one CPU core free
  
  return Math.min(maxByMemory, maxByCPU);
};

const POOL_MAX = process.env.BROWSER_POOL_MAX || calculatePoolSize();
const POOL_MIN = process.env.BROWSER_POOL_MIN || Math.max(1, Math.floor(POOL_MAX / 2));

// Reusable page configuration
const configureNewPage = async (page) => {
  // Enable request interception with more granular control
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url();
    
    // Block unnecessary resources
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
        url.includes('google-analytics') ||
        url.includes('doubleclick.net') ||
        url.includes('facebook.com')) {
      request.abort();
    } else {
      request.continue();
    }
  });

  // Optimize memory usage
  await page.setCacheEnabled(false);
  await page.setBypassCSP(true);

  // Set performance-oriented defaults
  await page.setDefaultNavigationTimeout(30000);
  await page.setDefaultTimeout(30000);

  return page;
};

class BrowserPool {
  constructor() {
    this.activeConnections = new Map(); // Changed to Map to store creation timestamps
    this.initializePool();
  }

  initializePool() {
    const factory = {
      create: async () => {
        try {
          const browser = await puppeteer.launch({
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--no-first-run',
              '--no-zygote',
              '--single-process',
              '--disable-extensions',
              '--disable-accelerated-2d-canvas',
              '--disable-ipc-flooding-protection',
              '--disable-background-networking',
              '--disable-default-apps',
              '--disable-sync',
              '--disable-translate',
              '--hide-scrollbars',
              '--metrics-recording-only',
              '--mute-audio',
              '--safebrowsing-disable-auto-update',
              '--ignore-certificate-errors',
              '--ignore-certificate-errors-spki-list',
              '--ignore-ssl-errors',
              '--disable-features=IsolateOrigins,site-per-process',
              '--disable-web-security',
              '--disable-features=site-per-process',
              '--window-size=1920,1080',
              `--js-flags=--max-old-space-size=${Math.floor(os.freemem() / (1024 * 1024))}`,
            ],
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
            defaultViewport: { width: 1920, height: 1080 },
            protocolTimeout: 30000,
            timeout: 30000,
            waitForInitialPage: true,
          });

          const pages = await browser.pages();
          const page = pages[0] || await browser.newPage();
          await configureNewPage(page);

          // Store creation time and setup disconnection handler
          this.activeConnections.set(browser, {
            createdAt: Date.now(),
            isDisconnected: false
          });

          browser.on('disconnected', () => {
            this.handleDisconnection(browser);
          });

          return browser;
        } catch (error) {
          console.error('Error creating browser instance:', error);
          throw error;
        }
      },
      destroy: async (browser) => {
        try {
          if (!browser.isConnected()) {
            console.log('Browser already disconnected, skipping normal cleanup');
            this.activeConnections.delete(browser);
            return;
          }

          const pages = await browser.pages();
          await Promise.all(pages.map(page => page.close().catch(console.error)));
          await browser.close();
          this.activeConnections.delete(browser);
        } catch (error) {
          console.error('Error during browser cleanup:', error);
          try {
            // Force cleanup if normal cleanup fails
            if (browser.process() != null) {
              browser.process().kill('SIGKILL');
            }
          } catch (e) {
            console.error('Error during force cleanup:', e);
          } finally {
            this.activeConnections.delete(browser);
          }
        }
      },
      validate: async (browser) => {
        try {
          return browser.isConnected() && !this.activeConnections.get(browser)?.isDisconnected;
        } catch (error) {
          return false;
        }
      }
    };

    this.pool = genericPool.createPool(factory, {
      max: POOL_MAX,
      min: POOL_MIN,
      testOnBorrow: true,
      acquireTimeoutMillis: 60000,
      idleTimeoutMillis: 30000,
      evictionRunIntervalMillis: 15000,
      numTestsPerEvictionRun: 3,
      autostart: true,
      fifo: false,
      priorityRange: 1,
      maxWaitingClients: 10,
      validateOnBorrow: true,
    });

    // Setup periodic health check
    this.startHealthCheck();
  }

  async handleDisconnection(browser) {
    try {
      const browserInfo = this.activeConnections.get(browser);
      if (browserInfo) {
        browserInfo.isDisconnected = true;
        
        // Only attempt to destroy if the browser was created recently
        const age = Date.now() - browserInfo.createdAt;
        if (age < 300000) { // 5 minutes
          console.log('Recent browser disconnected, attempting cleanup');
          await this.pool.destroy(browser).catch(() => {
            console.log('Expected: Resource not in pool (already cleaned up)');
          });
        } else {
          console.log('Old browser disconnected, skipping pool cleanup');
          this.activeConnections.delete(browser);
        }
      }
    } catch (error) {
      console.error('Error handling browser disconnection:', error);
      this.activeConnections.delete(browser);
    }
  }

  startHealthCheck() {
    setInterval(async () => {
      try {
        for (const [browser, info] of this.activeConnections) {
          if (!browser.isConnected() || info.isDisconnected) {
            await this.handleDisconnection(browser);
          }
        }
      } catch (error) {
        console.error('Error during health check:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  async getBrowser() {
    const browser = await this.pool.acquire();
    return browser;
  }

  async releaseBrowser(browser) {
    try {
      if (!browser.isConnected()) {
        console.log('Browser disconnected, handling as disconnection instead of release');
        await this.handleDisconnection(browser);
        return;
      }
      await this.pool.release(browser);
    } catch (error) {
      console.error('Error releasing browser:', error);
      await this.handleDisconnection(browser);
    }
  }

  async drain() {
    return await this.pool.drain();
  }

  async clear() {
    return await this.pool.clear();
  }

  getStats() {
    return {
      active: this.activeConnections.size,
      max: POOL_MAX,
      min: POOL_MIN,
      spareResourceCapacity: POOL_MAX - this.activeConnections.size,
      totalSystemMemory: os.totalmem(),
      freeSystemMemory: os.freemem(),
    };
  }
}

const browserPool = new BrowserPool();

// Graceful shutdown handlers
const cleanup = async (signal) => {
  console.log(`Received ${signal}. Cleaning up...`);
  try {
    await browserPool.drain();
    await browserPool.clear();
    process.exit(0);
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('SIGINT', () => cleanup('SIGINT'));

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

module.exports = { browserPool }; 