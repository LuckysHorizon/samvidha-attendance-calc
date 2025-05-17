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

      // Configure initial page
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      await configureNewPage(page);

      // Monitor browser health
      browser.on('disconnected', () => {
        console.error('Browser disconnected unexpectedly');
        pool.destroy(browser).catch(console.error);
      });

      return browser;
    } catch (error) {
      console.error('Error creating browser instance:', error);
      throw error;
    }
  },
  destroy: async (browser) => {
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map(page => page.close().catch(console.error)));
      await browser.close();
    } catch (error) {
      console.error('Error closing browser:', error);
      // Force close if normal close fails
      try {
        browser.process().kill('SIGKILL');
      } catch (e) {
        console.error('Error force closing browser:', e);
      }
    }
  },
  validate: async (browser) => {
    try {
      // Check if browser is still connected
      return browser.isConnected();
    } catch (error) {
      return false;
    }
  }
};

const pool = genericPool.createPool(factory, {
  max: POOL_MAX,
  min: POOL_MIN,
  testOnBorrow: true,
  acquireTimeoutMillis: 60000,
  idleTimeoutMillis: 30000,
  evictionRunIntervalMillis: 15000,
  numTestsPerEvictionRun: 3,
  autostart: true,
  fifo: false, // Use LIFO for better performance
  priorityRange: 1,
  maxWaitingClients: 10,
  validateOnBorrow: true,
});

class BrowserPool {
  constructor(pool) {
    this.pool = pool;
    this.activeConnections = new Set();
  }

  async getBrowser() {
    const browser = await this.pool.acquire();
    this.activeConnections.add(browser);
    return browser;
  }

  async releaseBrowser(browser) {
    this.activeConnections.delete(browser);
    return await this.pool.release(browser);
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

const browserPool = new BrowserPool(pool);

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