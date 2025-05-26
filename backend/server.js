const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { browserPool } = require('./config/browser');
const { attendanceCache } = require('./config/cache');
require('dotenv').config();

// Configure logger with more detailed format
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'attendance-calculator' },
  transports: [
    new winston.transports.File({ 
      filename: path.join(process.env.LOG_FILE_PATH || './logs', 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(process.env.LOG_FILE_PATH || './logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Create logs directory if it doesn't exist
const logDir = process.env.LOG_FILE_PATH || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const app = express();
const port = process.env.PORT || 3000;

// Security middleware with production-specific settings
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Optimize compression
app.use(compression({
  level: parseInt(process.env.COMPRESSION_LEVEL || '6'),
  threshold: '1kb',
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 7200 // Cache preflight requests for 2 hours
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Static file serving with caching
const staticOptions = {
  maxAge: '2h',
  etag: true,
  lastModified: true
};
app.use(express.static(path.join(__dirname, '../frontend'), staticOptions));
app.use('/css', express.static(path.join(__dirname, '../frontend/css'), staticOptions));
app.use('/js', express.static(path.join(__dirname, '../frontend/js'), staticOptions));

// Health check endpoint with basic metrics
app.get('/health', (req, res) => {
  const metrics = {
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    browserPool: {
      activeBrowsers: browserPool.getActiveBrowserCount(),
      activePages: browserPool.getActivePageCount()
    }
  };
  res.status(200).json(metrics);
});

// Helper function to login and get browser session with improved error handling
async function loginToSamvidha(username, password) {
  let browser;
  let page;
  try {
    browser = await browserPool.getBrowser();
    page = await browserPool.getPage();
    
    // Optimize page performance
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setRequestInterception(true);
    
    // Block unnecessary resources
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Set timeouts from environment variables
    page.setDefaultNavigationTimeout(parseInt(process.env.NAVIGATION_TIMEOUT || '30000'));
    page.setDefaultTimeout(parseInt(process.env.REQUEST_TIMEOUT || '30000'));

    // Navigate to login page with retry logic
    let retries = 3;
    while (retries > 0) {
      try {
        await page.goto(process.env.SAMVIDHA_URL || 'https://samvidha.iare.ac.in/', { 
          waitUntil: 'networkidle2',
          timeout: parseInt(process.env.SAMVIDHA_NAVIGATION_TIMEOUT || '60000')
        });
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Enter credentials with retry logic
    retries = 3;
    while (retries > 0) {
      try {
        await page.waitForSelector('input[name="txt_uname"]', { timeout: 30000 });
        await page.type('input[name="txt_uname"]', username);
        await page.type('input[name="txt_pwd"]', password);
        await page.click('button#but_submit');
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Wait for navigation with retry logic
    retries = 3;
    while (retries > 0) {
      try {
        await page.waitForNavigation({ 
          waitUntil: 'networkidle2',
          timeout: parseInt(process.env.SAMVIDHA_LOGIN_TIMEOUT || '60000')
        });
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Check for login failure
    if (page.url().includes('login')) {
      throw new Error('Invalid credentials');
    }

    return { browser, page };
  } catch (error) {
    if (page) await browserPool.releasePage(page);
    if (browser) await browserPool.releaseBrowser(browser);
    logger.error('Login error:', {
      error: error.message,
      stack: error.stack,
      username: username
    });
    throw error;
  }
}

// API routes
app.post('/fetch-attendance', async (req, res) => {
  console.log('Received /fetch-attendance request', req.body);
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Check cache first
  const cacheKey = `attendance_${username}`;
  const cachedData = attendanceCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  let browser;
  let page;
  try {
    const { browser: b, page: p } = await loginToSamvidha(username, password);
    browser = b;
    page = p;

    // Navigate to biometric page
    await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2' });

    // Scrape detailed attendance data
    const attendanceData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const attendanceDetails = rows.map(row => ({
        date: row.cells[0]?.innerText.trim(),
        day: row.cells[1]?.innerText.trim(),
        inTime: row.cells[2]?.innerText.trim(),
        outTime: row.cells[3]?.innerText.trim(),
        status: row.cells[6]?.innerText.trim().toLowerCase()
      }));

      let totalDays = rows.length;
      let presentDays = attendanceDetails.filter(detail => detail.status === 'present').length;
      let absentDays = totalDays - presentDays;

      return {
        details: attendanceDetails,
        summary: {
          totalDays,
          presentDays,
          absentDays
        }
      };
    });

    // Calculate attendance metrics
    const attendancePercentage = attendanceData.summary.totalDays > 0 
      ? ((attendanceData.summary.presentDays / attendanceData.summary.totalDays) * 100).toFixed(2) 
      : 0;

    let daysNeeded = 0;
    if (attendancePercentage < 75) {
      const requiredPresent = Math.ceil(0.75 * attendanceData.summary.totalDays);
      daysNeeded = requiredPresent - attendanceData.summary.presentDays;
    }

    const responseData = {
      totalClasses: attendanceData.summary.totalDays,
      present: attendanceData.summary.presentDays,
      absent: attendanceData.summary.absentDays,
      attendancePercentage,
      daysNeeded,
      details: attendanceData.details
    };

    // Clean up
    await browserPool.releasePage(page);
    await browserPool.releaseBrowser(browser);

    // Cache and return response
    attendanceCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
    if (page) await browserPool.releasePage(page);
    if (browser) await browserPool.releaseBrowser(browser);
    logger.error('Error in fetch-attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data: ' + error.message });
  }
});

app.post('/fetch-class-attendance', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let browser;
  let page;
  try {
    const { browser: b, page: p } = await loginToSamvidha(username, password);
    browser = b;
    page = p;

    // Navigate to course content page
    await page.goto('https://samvidha.iare.ac.in/home?action=course_content', { waitUntil: 'networkidle2' });
    
    // Wait for the table
    await page.waitForSelector('table.table', { timeout: 10000 });

    // Scrape course attendance data
    const courseData = await page.evaluate(() => {
      const courses = [];
      let currentCourse = null;
      
      // Get all rows from the table
      const rows = Array.from(document.querySelectorAll('table.table tbody tr'));
      
      rows.forEach(row => {
        // Check if this is a course header row (pink background)
        const courseHeader = row.querySelector('th.bg-pink');
        if (courseHeader) {
          if (currentCourse) {
            courses.push(currentCourse);
          }
          currentCourse = {
            courseName: courseHeader.textContent.trim(),
            classes: []
          };
        } 
        // If not a header row and we have a current course, this is a class entry
        else if (currentCourse && row.cells.length > 0) {
          const cells = row.cells;
          if (cells.length >= 5) { // Ensure we have enough cells
            currentCourse.classes.push({
              serialNo: cells[0]?.textContent.trim(),
              date: cells[1]?.textContent.trim(),
              period: cells[2]?.textContent.trim(),
              topicsCovered: cells[3]?.textContent.trim(),
              status: cells[4]?.textContent.trim().toUpperCase(),
              youtubeLink: cells[5]?.textContent.trim(),
              powerpoint: cells[6]?.querySelector('a')?.href || ''
            });
          }
        }
      });
      
      // Don't forget to push the last course
      if (currentCourse) {
        courses.push(currentCourse);
      }

      // Calculate statistics for each course
      return courses.map(course => {
        const totalClasses = course.classes.length;
        const presentClasses = course.classes.filter(c => c.status === 'PRESENT').length;
        const absentClasses = course.classes.filter(c => c.status === 'ABSENT').length;
        const attendancePercentage = totalClasses > 0 ? ((presentClasses / totalClasses) * 100).toFixed(2) : '0.00';
        
        return {
          ...course,
          statistics: {
            totalClasses,
            presentClasses,
            absentClasses,
            attendancePercentage
          }
        };
      });
    });

    if (courseData.length === 0) {
      throw new Error('No course data found');
    }

    // Clean up
    await browserPool.releasePage(page);
    await browserPool.releaseBrowser(browser);

    res.json({ courseData });
  } catch (error) {
    if (page) await browserPool.releasePage(page);
    if (browser) await browserPool.releaseBrowser(browser);
    logger.error('Error in fetch-class-attendance:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch class attendance data' });
  }
});

// Serve index.html for all other routes (catch-all, must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Update error handling middleware with better logging
app.use((err, req, res, next) => {
  const errorDetails = {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString()
  };
  
  logger.error('Unhandled error:', errorDetails);
  
  // Send appropriate error response
  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
    requestId: req.id // Add request ID for tracking
  });
});

// Start server with error handling
const server = app.listen(port, () => {
  logger.info(`Server is running on port ${port} in ${process.env.NODE_ENV} mode`);
}).on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = async () => {
  logger.info('Received shutdown signal');
  try {
    await browserPool.closeAll();
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', {
    error: error.message,
    stack: error.stack
  });
  gracefulShutdown();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', {
    reason: reason,
    stack: reason.stack
  });
  gracefulShutdown();
});
