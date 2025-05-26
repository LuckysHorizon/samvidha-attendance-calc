const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function installChrome() {
  try {
    console.log('Installing Chrome for Render environment...');
    
    // Check if we're on Render
    if (process.env.RENDER) {
      const chromeDir = path.join(process.cwd(), '.render', 'chrome');
      
      if (!fs.existsSync(chromeDir)) {
        console.log('Chrome not found, installing...');
        
        // Create directory
        fs.mkdirSync(chromeDir, { recursive: true });
        
        // Download and install Chrome
        const commands = [
          'curl -Lo chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
          `dpkg -x chrome.deb ${chromeDir}`,
          'rm chrome.deb'
        ];
        
        for (const cmd of commands) {
          console.log(`Running: ${cmd}`);
          execSync(cmd, { stdio: 'inherit' });
        }
        
        console.log('Chrome installed successfully!');
      } else {
        console.log('Chrome already installed.');
      }
    } else {
      console.log('Not on Render, skipping Chrome installation.');
    }
  } catch (error) {
    console.error('Error installing Chrome:', error.message);
    // Don't fail the build, just log the error
  }
}

if (require.main === module) {
  installChrome();
}

module.exports = installChrome;