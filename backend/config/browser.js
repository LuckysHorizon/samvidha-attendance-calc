const os = require('os');

const isProduction = process.env.NODE_ENV === 'production';

const getChromePath = () => {
  if (isProduction) {
    return process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
  }

  // For local development
  switch (os.platform()) {
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    default:
      return '/usr/bin/google-chrome';
  }
};

const getBrowserConfig = () => {
  const executablePath = getChromePath();
  
  return {
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920x1080',
    ],
    headless: 'new',
    timeout: parseInt(process.env.BROWSER_TIMEOUT || '60000'),
  };
};

module.exports = {
  getBrowserConfig,
  getChromePath,
}; 