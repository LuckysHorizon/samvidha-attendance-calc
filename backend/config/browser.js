const puppeteer = require('puppeteer');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'browser-pool' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Determine Chrome executable path based on environment
function getChromePath() {
  if (process.env.RENDER) {
    // Render environment
    return '/opt/render/project/.render/chrome/opt/google/chrome/google-chrome';
  } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Custom path from environment
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    // Local development - let Puppeteer handle it
    return null;
  }
}

// Optimized browser launch options for different environments
function getBrowserOptions() {
  const isWindows = process.platform === 'win32';
  const isRender = process.env.RENDER;
  
  const baseOptions = {
    headless: process.env.NODE_ENV === 'production' ? 'new' : false, // Visible in development
    defaultViewport: null,
    args: []
  };

  if (isRender) {
    // Render-specific options
    baseOptions.headless = 'new';
    baseOptions.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--memory-pressure-off',
      '--max_old_space_size=512',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ];
  } else if (isWindows) {
    // Windows-specific options for better stability
    baseOptions.args = [
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-extensions',
      '--disable-default-apps'
    ];
  } else {
    // Linux/Mac options
    baseOptions.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ];
  }

  const chromePath = getChromePath();
  if (chromePath) {
    baseOptions.executablePath = chromePath;
  }

  return baseOptions;
}

// Enhanced browser pool for better performance
class BrowserPool {
  constructor(options = {}) {
    this.maxBrowsers = options.maxBrowsers || parseInt(process.env.BROWSER_POOL_MAX) || 2;
    this.minBrowsers = options.minBrowsers || parseInt(process.env.BROWSER_POOL_MIN) || 1;
    this.browsers = [];
    this.currentIndex = 0;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;

    logger.info(`Initializing browser pool with ${this.minBrowsers} browsers`);
    
    for (let i = 0; i < this.minBrowsers; i++) {
      await this.createBrowser();
    }
    
    this.isInitialized = true;
    logger.info('Browser pool initialized successfully');
  }

  async getBrowser() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (this.browsers.length === 0) {
      await this.createBrowser();
    }

    // Find a connected browser
    for (let i = 0; i < this.browsers.length; i++) {
      const browser = this.browsers[i];
      if (browser && browser.isConnected()) {
        this.currentIndex = (this.currentIndex + 1) % this.browsers.length;
        return browser;
      }
    }

    // If no connected browsers, create a new one
    return await this.createBrowser();
  }

  async createBrowser() {
    try {
      logger.info('Creating new browser instance');
      const options = getBrowserOptions();
      logger.info('Browser options:', options);
      
      const browser = await puppeteer.launch(options);
      
      // Test browser connection immediately
      const pages = await browser.pages();
      if (pages.length === 0) {
        await browser.newPage();
      }
      
      this.browsers.push(browser);
      
      // Handle browser disconnect
      browser.on('disconnected', () => {
        logger.warn('Browser disconnected, removing from pool');
        const index = this.browsers.indexOf(browser);
        if (index > -1) {
          this.browsers.splice(index, 1);
        }
      });

      // Handle browser errors
      browser.on('error', (error) => {
        logger.error('Browser error:', error);
      });

      // Handle target errors
      browser.on('targetdestroyed', (target) => {
        logger.warn('Browser target destroyed:', target.url());
      });

      logger.info(`Browser created successfully. Pool size: ${this.browsers.length}`);
      return browser;
    } catch (error) {
      logger.error('Failed to create browser:', error);
      throw error;
    }
  }

  async releaseBrowser(browser) {
    // For now, we just keep the browser in the pool
    // In a more sophisticated implementation, you might close it if pool is too large
    if (this.browsers.length > this.maxBrowsers) {
      try {
        await browser.close();
        const index = this.browsers.indexOf(browser);
        if (index > -1) {
          this.browsers.splice(index, 1);
        }
        logger.info(`Browser closed. Pool size: ${this.browsers.length}`);
      } catch (error) {
        logger.error('Error closing browser:', error);
      }
    }
  }

  async closeAll() {
    logger.info('Closing all browsers in pool');
    const closePromises = this.browsers.map(async (browser) => {
      try {
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      } catch (error) {
        logger.error('Error closing browser:', error);
      }
    });

    await Promise.all(closePromises);
    this.browsers = [];
    this.isInitialized = false;
    logger.info('All browsers closed');
  }

  getPoolStatus() {
    return {
      totalBrowsers: this.browsers.length,
      connectedBrowsers: this.browsers.filter(b => b && b.isConnected()).length,
      maxBrowsers: this.maxBrowsers,
      minBrowsers: this.minBrowsers,
      isInitialized: this.isInitialized
    };
  }
}

// Create singleton browser pool
const browserPool = new BrowserPool({
  maxBrowsers: parseInt(process.env.BROWSER_POOL_MAX) || 2,
  minBrowsers: parseInt(process.env.BROWSER_POOL_MIN) || 1
});

// Graceful shutdown handlers
const gracefulShutdown = async () => {
  logger.info('Shutting down browser pool');
  await browserPool.closeAll();
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception in browser pool:', error);
  await gracefulShutdown();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled Rejection in browser pool:', reason);
  await gracefulShutdown();
  process.exit(1);
});

module.exports = {
  browserPool,
  getBrowserOptions,
  getChromePath,
  BrowserPool
};