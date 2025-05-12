const os = require('os');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';

const findChromePath = () => {
  // Prioritize environment variables
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN;
  }

  // Default to chromium in production (Render/Docker)
  if (isProduction) {
    return '/usr/bin/chromium';
  }

  // Common Chrome paths for development
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
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ]
  };

  const platformPaths = paths[os.platform()] || paths.linux;
  
  for (const chromePath of platformPaths) {
    try {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    } catch (error) {
      continue;
    }
  }

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
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-extensions',
      '--mute-audio',
      '--no-first-run'
    ],
    headless: 'new',
    timeout: 20000, // Reduced for faster failure
    ignoreHTTPSErrors: true
  };
};

module.exports = {
  getBrowserConfig,
  findChromePath
};
