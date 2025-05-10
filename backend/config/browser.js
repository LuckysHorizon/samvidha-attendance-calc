const os = require('os');
const fs = require('fs');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

const findChromePath = () => {
  // First check environment variables
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  // Common Chrome paths for different platforms
  const paths = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ]
  };

  // Check platform-specific paths
  const platformPaths = paths[os.platform()] || paths.linux;
  
  // Find the first existing Chrome executable
  for (const chromePath of platformPaths) {
    try {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    } catch (error) {
      continue;
    }
  }

  // If no Chrome found, return the default path for the platform
  return platformPaths[0];
};

const getBrowserConfig = () => {
  const executablePath = findChromePath();
  
  return {
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-features=site-per-process'
    ],
    headless: 'new',
    timeout: parseInt(process.env.BROWSER_TIMEOUT || '60000'),
    ignoreHTTPSErrors: true
  };
};

module.exports = {
  getBrowserConfig,
  findChromePath
}; 