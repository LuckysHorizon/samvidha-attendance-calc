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

    // Handle browser disconnection
    this.browser.on('disconnected', () => {
      this.handleBrowserDisconnect();
    });
  }

  handleBrowserDisconnect() {
    // Clear all page references when browser disconnects
    this.availablePages = [];
    this.busyPages.clear();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    logger.info('Initializing page pool');
    
    try {
      // Pre-create some pages
      for (let i = 0; i < 2; i++) {
        const page = await this.createPage();
        if (page) {
          this.availablePages.push(page);
        }
      }
      
      this.initialized = true;
      logger.info(`Page pool initialized with ${this.availablePages.length} pages`);
    } catch (error) {
      logger.error('Error initializing page pool:', error);
      throw error;
    }
  }

  async createPage() {
    try {
      if (!this.browser.isConnected()) {
        throw new Error('Browser is not connected');
      }

      const page = await this.browser.newPage();
      
      // Set user agent to avoid detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');
      
      // Set viewport
      await page.setViewport({ width: 1366, height: 768 });
      
      // Handle page errors
      page.on('error', (error) => {
        logger.error('Page error:', error);
        this.cleanupPage(page);
      });

      page.on('pageerror', (error) => {
        logger.error('Page JavaScript error:', error);
      });

      // Handle page close
      page.on('close', () => {
        this.cleanupPage(page);
      });

      return page;
    } catch (error) {
      logger.error('Error creating page:', error);
      return null;
    }
  }

  cleanupPage(page) {
    this.busyPages.delete(page);
    const index = this.availablePages.indexOf(page);
    if (index > -1) {
      this.availablePages.splice(index, 1);
    }
  }

  async getPage() {
    if (!this.browser.isConnected()) {
      throw new Error('Browser is not connected');
    }

    if (!this.initialized) {
      await this.initialize();
    }

    // Get available page or create new one
    let page = this.availablePages.pop();
    
    if (!page && (this.busyPages.size + this.availablePages.length) < this.maxPages) {
      page = await this.createPage();
    }
    
    if (!page) {
      throw new Error('No pages available');
    }

    this.busyPages.add(page);
    return page;
  }

  async releasePage(page) {
    if (!page) {
      return;
    }

    try {
      if (page.isClosed()) {
        this.cleanupPage(page);
        return;
      }

      // Clear the page state but don't close it
      await page.evaluate(() => {
        if (typeof Storage !== 'undefined') {
          localStorage.clear();
          sessionStorage.clear();
        }
        if (document.cookie) {
          document.cookie.split(";").forEach(c => {
            document.cookie = c.replace(/^ +/, "")
              .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
          });
        }
      }).catch(() => {
        // Ignore evaluation errors on disconnected pages
      });

      // Navigate to blank page to free up resources
      await page.goto('about:blank').catch(() => {
        // Ignore navigation errors on disconnected pages
      });
      
      this.busyPages.delete(page);
      this.availablePages.push(page);
      
      logger.debug('Page released back to pool');
    } catch (error) {
      logger.error('Error releasing page:', error);
      this.cleanupPage(page);
    }
  }

  async closeAll() {
    logger.info('Closing all pages in pool');
    
    const allPages = [...this.availablePages, ...this.busyPages];
    const closePromises = allPages.map(async (page) => {
      try {
        if (page && !page.isClosed()) {
          await page.close().catch(() => {
            // Ignore close errors on already closed pages
          });
        }
      } catch (error) {
        // Log but don't throw
        logger.error('Error closing page:', error);
      }
    });

    await Promise.allSettled(closePromises);
    this.availablePages = [];
    this.busyPages.clear();
    this.initialized = false;
  }

  getStatus() {
    return {
      availablePages: this.availablePages.length,
      busyPages: this.busyPages.size,
      totalPages: this.availablePages.length + this.busyPages.size,
      maxPages: this.maxPages,
      browserConnected: this.browser.isConnected()
    };
  }
}

// Enhanced browser pool for persistent browsers
class PersistentBrowserPool {
  constructor(options = {}) {
    this.minBrowsers = options.minBrowsers || 1;
    this.maxBrowsers = options.maxBrowsers || 1;
    this.browsers = new Set();
    this.pagePool = null;
    this.initialized = false;
    this.initializing = false;
    this.healthCheckInterval = null;
    this.initializationPromise = null;
    this.reconnectDelay = 5000; // 5 seconds delay between reconnection attempts
    this.maxReconnectAttempts = 3;
  }

  async initialize() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    if (this.initialized) return;

    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  async _doInitialize() {
    logger.info(`Initializing persistent browser pool with ${this.minBrowsers} browsers`);
    
    for (let i = 0; i < this.minBrowsers; i++) {
      await this.createBrowser();
    }
    
    this.initialized = true;
    this.startHealthCheck();
    
    logger.info('Persistent browser pool initialized successfully');
  }

  async handleBrowserDisconnect(disconnectedBrowser) {
    try {
      logger.warn('Browser disconnected, attempting to recreate');
      
      // Remove from set
      this.browsers.delete(disconnectedBrowser);
      
      // Clean up page pool
      if (this.pagePool) {
        await this.pagePool.closeAll().catch(error => {
          logger.error('Error closing page pool:', error);
        });
        this.pagePool = null;
      }

      // Attempt to recreate browser with retries
      let attempts = 0;
      while (attempts < this.maxReconnectAttempts) {
        try {
          if (this.browsers.size < this.minBrowsers) {
            logger.info(`Recreating browser attempt ${attempts + 1}/${this.maxReconnectAttempts}`);
            await this.createBrowser();
            break;
          }
        } catch (error) {
          attempts++;
          if (attempts === this.maxReconnectAttempts) {
            logger.error('Failed to recreate browser after maximum attempts:', error);
            throw error;
          }
          logger.warn(`Browser recreation attempt ${attempts} failed, retrying in ${this.reconnectDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
        }
      }
    } catch (error) {
      logger.error('Error handling browser disconnect:', error);
      throw error;
    }
  }

  async createBrowser() {
    try {
      logger.info('Creating new persistent browser instance');
      const options = getBrowserOptions();
      logger.info('Browser options:', options);
      
      const browser = await puppeteer.launch(options);
      
      // Create page pool for this browser
      const pagePool = new PagePool(browser, 5);
      await pagePool.initialize();
      
      this.browsers.add(browser);
      this.pagePool = pagePool;
      
      // Handle browser disconnect with debounce to prevent multiple handlers
      let disconnectTimeout;
      browser.on('disconnected', async () => {
        clearTimeout(disconnectTimeout);
        disconnectTimeout = setTimeout(async () => {
          try {
            await this.handleBrowserDisconnect(browser);
          } catch (error) {
            logger.error('Error in browser disconnect handler:', error);
          }
        }, 1000); // Debounce for 1 second
      });

      logger.info(`Persistent browser created successfully. Pool size: ${this.browsers.size}`);
      return browser;
    } catch (error) {
      logger.error('Failed to create persistent browser:', error);
      throw error;
    }
  }

  async getBrowser() {
    if (!this.initialized) {
      await this.initialize();
    }

    // Find a connected browser
    for (const browser of this.browsers) {
      if (browser && browser.isConnected()) {
        return browser;
      }
    }

    // If no connected browsers, create a new one with retries
    let attempts = 0;
    while (attempts < this.maxReconnectAttempts) {
      try {
        logger.warn(`No connected browsers found, creating new one (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
        return await this.createBrowser();
      } catch (error) {
        attempts++;
        if (attempts === this.maxReconnectAttempts) {
          logger.error('Failed to create browser after maximum attempts:', error);
          throw error;
        }
        logger.warn(`Browser creation attempt ${attempts} failed, retrying in ${this.reconnectDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      }
    }
  }

  async getPage() {
    try {
      const browser = await this.getBrowser();
      const pagePool = this.pagePool;
      
      if (!pagePool) {
        throw new Error('No page pool available');
      }

      return await pagePool.getPage();
    } catch (error) {
      logger.error('Error getting page:', error);
      throw error;
    }
  }

  async releasePage(page) {
    if (!page) return;

    try {
      // Find the browser this page belongs to
      for (const browser of this.browsers) {
        if (browser && browser.isConnected()) {
          const pages = await browser.pages().catch(() => []);
          if (pages.includes(page)) {
            await this.pagePool.releasePage(page);
            return;
          }
        }
      }
      
      // If we get here, the page is orphaned
      logger.warn('Could not find browser for page, closing page');
      try {
        if (!page.isClosed()) {
          await page.close().catch(() => {
            // Ignore close errors on already closed pages
          });
        }
      } catch (error) {
        logger.error('Error closing orphaned page:', error);
      }
    } catch (error) {
      logger.error('Error releasing page:', error);
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
    
    const connectedBrowsers = Array.from(this.browsers);
    
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
    const pagePoolPromises = Array.from(this.browsers).map(async (browser) => {
      try {
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      } catch (error) {
        logger.error('Error closing browser:', error);
      }
    });

    await Promise.all(pagePoolPromises);
    this.browsers.clear();
    this.pagePool = null;
    this.initialized = false;
    this.initializationPromise = null;
    
    logger.info('All browsers closed');
  }

  getPoolStatus() {
    const browserStatus = Array.from(this.browsers).map(browser => ({
      connected: browser ? browser.isConnected() : false,
      pagePool: this.pagePool?.getStatus() || null
    }));

    return {
      totalBrowsers: this.browsers.size,
      connectedBrowsers: this.browsers.size,
      maxBrowsers: this.maxBrowsers,
      minBrowsers: this.minBrowsers,
      isInitialized: this.initialized,
      browsers: browserStatus
    };
  }

  async releaseBrowser(browser) {
    // Instead of actually releasing the browser, we'll just release its pages
    // since we're maintaining a persistent pool
    try {
      if (this.pagePool) {
        await this.pagePool.closeAll().catch(error => {
          logger.error('Error closing pages during browser release:', error);
        });
      }
    } catch (error) {
      logger.error('Error releasing browser:', error);
    }
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