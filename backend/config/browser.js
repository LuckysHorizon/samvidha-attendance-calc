const puppeteer = require('puppeteer');
const genericPool = require('generic-pool');
const os = require('os');

// Dynamic pool sizing based on available system resources
const calculatePoolSize = () => {
  const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
  const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);
  const cpuCount = os.cpus().length;
  
  // More conservative pool sizing for stability
  const maxByMemory = Math.floor(freeMemoryGB / 0.75); // Increased memory per instance
  const maxByCPU = Math.max(1, Math.floor(cpuCount / 2)); // More conservative CPU usage
  
  return Math.min(maxByMemory, maxByCPU, 3); // Cap at 3 instances for stability
};

const POOL_MAX = parseInt(process.env.BROWSER_POOL_MAX) || calculatePoolSize();
const POOL_MIN = parseInt(process.env.BROWSER_POOL_MIN) || Math.max(1, Math.floor(POOL_MAX / 2));

// Reusable page configuration
const configureNewPage = async (page) => {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const url = request.url();
    
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType) ||
        url.includes('google-analytics') ||
        url.includes('doubleclick.net') ||
        url.includes('facebook.com')) {
      request.abort();
    } else {
      request.continue();
    }
  });

  // Optimize page settings
  await page.setCacheEnabled(true); // Enable cache for better performance
  await page.setBypassCSP(true);
  
  // Use environment variables for timeouts with fallbacks
  const navigationTimeout = parseInt(process.env.NAVIGATION_TIMEOUT) || 60000;
  const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT) || 60000;
  
  await page.setDefaultNavigationTimeout(navigationTimeout);
  await page.setDefaultTimeout(requestTimeout);

  return page;
};

class BrowserPool {
  constructor() {
    this.activeConnections = new Map();
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
              `--js-flags=--max-old-space-size=${Math.floor(os.freemem() / (1024 * 1024) * 0.75)}`,
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
            ],
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
            defaultViewport: { width: 1920, height: 1080 },
            protocolTimeout: parseInt(process.env.PROTOCOL_TIMEOUT) || 60000,
            timeout: parseInt(process.env.BROWSER_LAUNCH_TIMEOUT) || 60000,
            waitForInitialPage: true,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
          });

          const pages = await browser.pages();
          const page = pages[0] || await browser.newPage();
          await configureNewPage(page);

          this.activeConnections.set(browser, {
            createdAt: Date.now(),
            isDisconnected: false,
            lastUsed: Date.now()
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
          const isValid = browser.isConnected() && !this.activeConnections.get(browser)?.isDisconnected;
          if (isValid) {
            const browserInfo = this.activeConnections.get(browser);
            if (browserInfo) {
              browserInfo.lastUsed = Date.now();
            }
          }
          return isValid;
        } catch (error) {
          return false;
        }
      }
    };

    const idleTimeoutMillis = parseInt(process.env.POOL_IDLE_TIMEOUT) || 300000; // 5 minutes
    const acquireTimeoutMillis = parseInt(process.env.POOL_ACQUIRE_TIMEOUT) || 120000; // 2 minutes
    const evictionRunIntervalMillis = parseInt(process.env.POOL_EVICTION_INTERVAL) || 60000; // 1 minute

    this.pool = genericPool.createPool(factory, {
      max: POOL_MAX,
      min: POOL_MIN,
      testOnBorrow: true,
      acquireTimeoutMillis: acquireTimeoutMillis,
      idleTimeoutMillis: idleTimeoutMillis,
      evictionRunIntervalMillis: evictionRunIntervalMillis,
      numTestsPerEvictionRun: 3,
      autostart: true,
      fifo: true, // Changed to true for better resource utilization
      priorityRange: 1,
      maxWaitingClients: POOL_MAX * 2,
      validateOnBorrow: true,
    });

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