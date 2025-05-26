const puppeteer = require('puppeteer');
const path = require('path');

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

// Optimized browser launch options for Render
function getBrowserOptions() {
  const baseOptions = {
    headless: 'new', // Use new headless mode
    args: [
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
    ]
  };

  const chromePath = getChromePath();
  if (chromePath) {
    baseOptions.executablePath = chromePath;
  }

  return baseOptions;
}

// Enhanced browser pool for better performance
class BrowserPool {
  constructor(maxBrowsers = 2) {
    this.browsers = [];
    this.maxBrowsers = maxBrowsers;
    this.currentIndex = 0;
  }

  async getBrowser() {
    if (this.browsers.length === 0) {
      await this.createBrowser();
    }

    const browser = this.browsers[this.currentIndex % this.browsers.length];
    this.currentIndex++;

    // Check if browser is still connected
    if (!browser.isConnected()) {
      await this.replaceBrowser(this.currentIndex - 1);
      return this.getBrowser();
    }

    return browser;
  }

  async createBrowser() {
    try {
      const browser = await puppeteer.launch(getBrowserOptions());
      this.browsers.push(browser);
      
      // Handle browser disconnect
      browser.on('disconnected', () => {
        const index = this.browsers.indexOf(browser);
        if (index > -1) {
          this.browsers.splice(index, 1);
        }
      });

      return browser;
    } catch (error) {
      console.error('Failed to create browser:', error);
      throw error;
    }
  }

  async replaceBrowser(index) {
    if (this.browsers[index]) {
      try {
        await this.browsers[index].close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }

    const newBrowser = await this.createBrowser();
    this.browsers[index] = newBrowser;
  }

  async closeAll() {
    const closePromises = this.browsers.map(browser => {
      try {
        return browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
        return Promise.resolve();
      }
    });

    await Promise.all(closePromises);
    this.browsers = [];
  }
}

// Create singleton browser pool
const browserPool = new BrowserPool(
  parseInt(process.env.BROWSER_POOL_MAX) || 2
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Closing browser pool...');
  await browserPool.closeAll();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Closing browser pool...');
  await browserPool.closeAll();
  process.exit(0);
});

module.exports = {
  getBrowserOptions,
  getChromePath,
  browserPool,
  BrowserPool
};