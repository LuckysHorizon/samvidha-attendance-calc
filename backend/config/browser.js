const puppeteer = require('puppeteer-core');
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

// Function to get Chrome path based on OS
function getChromePath() {
  switch (os.platform()) {
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    default:
      return '/usr/bin/google-chrome';
  }
}

class BrowserPool {
  constructor() {
    this.browsers = [];
    this.maxBrowsers = 3;
    this.initializePool();
  }

  initializePool() {
    const factory = {
      create: async () => {
        try {
          const browser = await puppeteer.launch({
            headless: 'new',
            executablePath: getChromePath(),
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--disable-gpu',
              '--window-size=1920,1080'
            ]
          });

          const browserEntry = {
            browser,
            inUse: true
          };

          this.browsers.push(browserEntry);
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
            return;
          }

          await browser.close();
        } catch (error) {
          console.error('Error during browser cleanup:', error);
          try {
            if (browser.process() != null) {
              browser.process().kill('SIGKILL');
            }
          } catch (e) {
            console.error('Error during force cleanup:', e);
          }
        }
      },
      validate: async (browser) => {
        try {
          const isValid = browser.isConnected();
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

  startHealthCheck() {
    setInterval(async () => {
      try {
        for (const browser of this.browsers) {
          if (!browser.browser.isConnected()) {
            await this.handleDisconnection(browser.browser);
          }
        }
      } catch (error) {
        console.error('Error during health check:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  async getBrowser() {
    try {
      // Try to reuse an existing browser
      const availableBrowser = this.browsers.find(b => !b.inUse);
      if (availableBrowser) {
        availableBrowser.inUse = true;
        return availableBrowser.browser;
      }

      // Create new browser if pool isn't full
      if (this.browsers.length < this.maxBrowsers) {
        const browser = await puppeteer.launch({
          headless: 'new',
          executablePath: getChromePath(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080'
          ]
        });

        const browserEntry = {
          browser,
          inUse: true
        };

        this.browsers.push(browserEntry);
        return browser;
      }

      // Wait for a browser to become available
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          const availableBrowser = this.browsers.find(b => !b.inUse);
          if (availableBrowser) {
            clearInterval(checkInterval);
            availableBrowser.inUse = true;
            resolve(availableBrowser.browser);
          }
        }, 1000);
      });
    } catch (error) {
      console.error('Error creating browser instance:', error);
      throw error;
    }
  }

  async releaseBrowser(browser) {
    const browserEntry = this.browsers.find(b => b.browser === browser);
    if (browserEntry) {
      browserEntry.inUse = false;
    }
  }

  async closeAll() {
    await Promise.all(this.browsers.map(async (b) => {
      try {
        await b.browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }));
    this.browsers = [];
  }

  async drain() {
    return await this.pool.drain();
  }

  async clear() {
    return await this.pool.clear();
  }

  getStats() {
    return {
      active: this.browsers.length,
      max: POOL_MAX,
      min: POOL_MIN,
      spareResourceCapacity: POOL_MAX - this.browsers.length,
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
    await browserPool.closeAll();
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