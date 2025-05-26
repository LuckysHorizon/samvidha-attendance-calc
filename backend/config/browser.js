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
    headless: process.env.NODE_ENV === 'production' ? 'new' : false,
    defaultViewport: { width: 1366, height: 768 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: []
  };

  if (isRender) {
    // Render-specific options for persistent browser
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
      '--disable-features=VizDisplayCompositor',
      // Keep browser alive
      '--keep-alive-for-test',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain'
    ];
  } else if (isWindows) {
    baseOptions.args = [
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-extensions',
      '--disable-default-apps'
    ];
  } else {
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

// Page pool to manage individual pages within browsers
class PagePool {
  constructor(browser, maxPages = 5) {
    this.browser = browser;
    this.maxPages = maxPages;
    this.availablePages = [];
    this.busyPages = new Set();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    logger.info('Initializing page pool');
    
    // Pre-create some pages
    for (let i = 0; i < 2; i++) {
      const page = await this.createPage();
      this.availablePages.push(page);
    }
    
    this.initialized = true;
    logger.info(`Page pool initialized with ${this.availablePages.length} pages`);
  }

  async createPage() {
    const page = await this.browser.newPage();
    
    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1366, height: 768 });
    
    // Handle page errors
    page.on('error', (error) => {
      logger.error('Page error:', error);
    });

    page.on('pageerror', (error) => {
      logger.error('Page JavaScript error:', error);
    });

    // Handle page close
    page.on('close', () => {
      logger.warn('Page was closed unexpectedly');
      this.busyPages.delete(page);
      const index = this.availablePages.indexOf(page);
      if (index > -1) {
        this.availablePages.splice(index, 1);
      }
    });

    return page;
  }

  async getPage() {
    if (!this.initialized) {
      await this.initialize();
    }

    // Get available page or create new one
    let page = this.availablePages.pop();
    
    if (!page && (this.busyPages.size + this.availablePages.length) < this.maxPages) {
      page = await this.createPage();
    }
    
    if (!page) {
      // Wait for a page to become available
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.getPage();
    }

    this.busyPages.add(page);
    return page;
  }

  async releasePage(page) {
    if (!page || page.isClosed()) {
      this.busyPages.delete(page);
      return;
    }

    try {
      // Clear the page state but don't close it
      await page.evaluate(() => {
        // Clear localStorage, sessionStorage, etc.
        if (typeof Storage !== 'undefined') {
          localStorage.clear();
          sessionStorage.clear();
        }
        // Clear cookies
        return new Promise(resolve => {
          if (document.cookie) {
            document.cookie.split(";").forEach(c => {
              document.cookie = c.replace(/^ +/, "")
                .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
            });
          }
          resolve();
        });
      });

      // Navigate to blank page to free up resources
      await page.goto('about:blank');
      
      this.busyPages.delete(page);
      this.availablePages.push(page);
      
      logger.debug('Page released back to pool');
    } catch (error) {
      logger.error('Error releasing page:', error);
      this.busyPages.delete(page);
      // Don't add it back to available pages if there was an error
    }
  }

  getStatus() {
    return {
      availablePages: this.availablePages.length,
      busyPages: this.busyPages.size,
      totalPages: this.availablePages.length + this.busyPages.size,
      maxPages: this.maxPages
    };
  }

  async closeAll() {
    logger.info('Closing all pages in pool');
    
    const allPages = [...this.availablePages, ...this.busyPages];
    const closePromises = allPages.map(async (page) => {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (error) {
        logger.error('Error closing page:', error);
      }
    });

    await Promise.all(closePromises);
    this.availablePages = [];
    this.busyPages.clear();
    this.initialized = false;
  }
}

// Enhanced browser pool for persistent browsers
class PersistentBrowserPool {
  constructor(options = {}) {
    this.maxBrowsers = options.maxBrowsers || parseInt(process.env.BROWSER_POOL_MAX) || 1;
    this.minBrowsers = options.minBrowsers || parseInt(process.env.BROWSER_POOL_MIN) || 1;
    this.browsers = [];
    this.pagePools = new Map();
    this.currentIndex = 0;
    this.isInitialized = false;
    this.healthCheckInterval = null;
    this.initializationPromise = null;
  }

  async initialize() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    if (this.isInitialized) return;

    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  async _doInitialize() {
    logger.info(`Initializing persistent browser pool with ${this.minBrowsers} browsers`);
    
    for (let i = 0; i < this.minBrowsers; i++) {
      await this.createBrowser();
    }
    
    this.isInitialized = true;
    this.startHealthCheck();
    
    logger.info('Persistent browser pool initialized successfully');
  }

  async createBrowser() {
    try {
      logger.info('Creating new persistent browser instance');
      const options = getBrowserOptions();
      logger.info('Browser options:', JSON.stringify(options, null, 2));
      
      const browser = await puppeteer.launch(options);
      
      // Create page pool for this browser
      const pagePool = new PagePool(browser, 5);
      await pagePool.initialize();
      
      this.browsers.push(browser);
      this.pagePools.set(browser, pagePool);
      
      // Handle browser disconnect - but try to recreate
      browser.on('disconnected', async () => {
        logger.warn('Browser disconnected, attempting to recreate');
        await this.handleBrowserDisconnect(browser);
      });

      // Handle browser errors
      browser.on('error', (error) => {
        logger.error('Browser error:', error);
      });

      logger.info(`Persistent browser created successfully. Pool size: ${this.browsers.length}`);
      return browser;
    } catch (error) {
      logger.error('Failed to create persistent browser:', error);
      throw error;
    }
  }

  async handleBrowserDisconnect(disconnectedBrowser) {
    try {
      // Remove from arrays
      const index = this.browsers.indexOf(disconnectedBrowser);
      if (index > -1) {
        this.browsers.splice(index, 1);
      }
      
      // Clean up page pool
      const pagePool = this.pagePools.get(disconnectedBrowser);
      if (pagePool) {
        await pagePool.closeAll();
        this.pagePools.delete(disconnectedBrowser);
      }

      // Create replacement browser if we're below minimum
      if (this.browsers.length < this.minBrowsers) {
        logger.info('Recreating browser to maintain minimum pool size');
        await this.createBrowser();
      }
    } catch (error) {
      logger.error('Error handling browser disconnect:', error);
    }
  }

  async getBrowser() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Find a connected browser
    for (let i = 0; i < this.browsers.length; i++) {
      const browser = this.browsers[i];
      if (browser && browser.isConnected()) {
        return browser;
      }
    }

    // If no connected browsers, create a new one
    logger.warn('No connected browsers found, creating new one');
    return await this.createBrowser();
  }

  async getPage() {
    const browser = await this.getBrowser();
    const pagePool = this.pagePools.get(browser);
    
    if (!pagePool) {
      logger.error('No page pool found for browser');
      throw new Error('No page pool available');
    }

    return await pagePool.getPage();
  }

  async releasePage(page) {
    // Find the browser this page belongs to
    for (const [browser, pagePool] of this.pagePools.entries()) {
      if (browser.isConnected()) {
        const pages = await browser.pages();
        if (pages.includes(page)) {
          await pagePool.releasePage(page);
          return;
        }
      }
    }
    
    logger.warn('Could not find browser for page, closing page');
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      logger.error('Error closing orphaned page:', error);
    }
  }

  startHealthCheck() {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        logger.error('Health check failed:', error);
      }
    }, 30000); // Check every 30 seconds

    logger.info('Health check started');
  }

  async performHealthCheck() {
    logger.debug('Performing health check');
    
    const connectedBrowsers = this.browsers.filter(b => b && b.isConnected());
    
    if (connectedBrowsers.length < this.minBrowsers) {
      logger.warn(`Only ${connectedBrowsers.length} browsers connected, minimum is ${this.minBrowsers}`);
      
      const browsersToCreate = this.minBrowsers - connectedBrowsers.length;
      for (let i = 0; i < browsersToCreate; i++) {
        try {
          await this.createBrowser();
        } catch (error) {
          logger.error('Failed to create browser during health check:', error);
        }
      }
    }

    // Test each browser by creating a test page
    for (const browser of connectedBrowsers) {
      try {
        const testPage = await browser.newPage();
        await testPage.goto('about:blank');
        await testPage.close();
      } catch (error) {
        logger.error('Browser health check failed:', error);
      }
    }
  }

  async closeAll() {
    logger.info('Closing all browsers in persistent pool');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Close all page pools first
    const pagePoolPromises = Array.from(this.pagePools.values()).map(pool => pool.closeAll());
    await Promise.all(pagePoolPromises);
    this.pagePools.clear();

    // Then close browsers
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
    this.initializationPromise = null;
    
    logger.info('All browsers closed');
  }

  getPoolStatus() {
    const browserStatus = this.browsers.map(browser => ({
      connected: browser ? browser.isConnected() : false,
      pagePool: this.pagePools.get(browser)?.getStatus() || null
    }));

    return {
      totalBrowsers: this.browsers.length,
      connectedBrowsers: this.browsers.filter(b => b && b.isConnected()).length,
      maxBrowsers: this.maxBrowsers,
      minBrowsers: this.minBrowsers,
      isInitialized: this.isInitialized,
      browsers: browserStatus
    };
  }
}

// Create singleton persistent browser pool
const persistentBrowserPool = new PersistentBrowserPool({
  maxBrowsers: parseInt(process.env.BROWSER_POOL_MAX) || 1,
  minBrowsers: parseInt(process.env.BROWSER_POOL_MIN) || 1
});

// Initialize the pool immediately when module loads
persistentBrowserPool.initialize().catch(error => {
  logger.error('Failed to initialize browser pool on startup:', error);
});

// Graceful shutdown handlers
const gracefulShutdown = async () => {
  logger.info('Shutting down persistent browser pool');
  await persistentBrowserPool.closeAll();
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
  browserPool: persistentBrowserPool,
  getBrowserOptions,
  getChromePath,
  PersistentBrowserPool
};