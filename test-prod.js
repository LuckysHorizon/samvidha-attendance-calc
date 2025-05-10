const { spawn } = require('child_process');
const path = require('path');

// Set production environment variables
process.env.NODE_ENV = 'production';
process.env.PORT = 3000;
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

// Start the server
const server = spawn('node', ['backend/server.js'], {
  stdio: 'inherit',
  env: process.env
});

// Handle server events
server.on('error', (error) => {
  console.error('Failed to start server:', error);
});

server.on('close', (code) => {
  console.log(`Server process exited with code ${code}`);
});

// Handle process termination
process.on('SIGINT', () => {
  server.kill();
  process.exit();
}); 