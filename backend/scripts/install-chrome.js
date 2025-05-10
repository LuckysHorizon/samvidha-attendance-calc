const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Create scripts directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname))) {
  fs.mkdirSync(path.join(__dirname), { recursive: true });
}

// Install Chrome dependencies for Ubuntu
console.log('Installing Chrome dependencies...');
try {
  execSync('apt-get update && apt-get install -y wget gnupg2', { stdio: 'inherit' });
  execSync('wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -', { stdio: 'inherit' });
  execSync('echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list', { stdio: 'inherit' });
  execSync('apt-get update && apt-get install -y google-chrome-stable', { stdio: 'inherit' });
  console.log('Chrome installed successfully!');
} catch (error) {
  console.error('Error installing Chrome:', error);
  process.exit(1);
} 