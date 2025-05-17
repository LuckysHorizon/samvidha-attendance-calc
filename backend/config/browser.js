const puppeteer = require('puppeteer');
const genericPool = require('generic-pool');

const POOL_MAX = process.env.BROWSER_POOL_MAX || 2;
const POOL_MIN = process.env.BROWSER_POOL_MIN || 1;

const factory = {
  create: async () => {
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
        '--no-sandbox',
        '--safebrowsing-disable-auto-update',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--window-size=1920,1080',
      ],
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 60000,
      timeout: 60000,
      waitForInitialPage: true,
    });

    // Enable request interception for better performance
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      // Skip unnecessary resources
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    return browser;
  },
  destroy: async (browser) => {
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map(page => page.close()));
      await browser.close();
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  },
};

const browserPool = genericPool.createPool(factory, {
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
});

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  await browserPool.drain();
  await browserPool.clear();
});

process.on('SIGINT', async () => {
  await browserPool.drain();
  await browserPool.clear();
});

module.exports = { browserPool }; 