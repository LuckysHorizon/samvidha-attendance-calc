const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const winston = require('winston');
const path = require('path');
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
      filename: 'error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

const app = express();
const port = process.env.PORT || 3000;

// Security middleware with production-specific settings
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(morgan('combined'));
app.use(cors({
  origin: '*',  // Allow all origins in development
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from the frontend directory
app.use(express.static(path.join(__dirname, '../frontend'), {
  maxAge: '1d',
  etag: true
}));

// Rate limiting middleware with production-specific settings
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 50 : 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Helper function to login and get browser session with improved error handling
async function loginToSamvidha(username, password) {
  let browser;
  try {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
      ],
      ignoreHTTPSErrors: true
    };

    // Set Chrome path in production
    if (process.env.NODE_ENV === 'production') {
      launchOptions.executablePath = process.env.CHROME_BIN || '/usr/bin/chromium';
      // Add additional production-specific arguments
      launchOptions.args.push(
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--mute-audio'
      );
    }

    browser = await puppeteer.launch(launchOptions);
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Set timeouts
    page.setDefaultNavigationTimeout(60000); // Increased timeout for production
    page.setDefaultTimeout(60000);

    // Navigate to login page with retry logic
    let retries = 3;
    while (retries > 0) {
      try {
        await page.goto('https://samvidha.iare.ac.in/', { 
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
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
          timeout: 60000
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
    if (browser) {
      await browser.close();
    }
    logger.error('Login error:', {
      error: error.message,
      stack: error.stack,
      username: username
    });
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/fetch-attendance', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let browser;
  try {
    const { browser: b, page } = await loginToSamvidha(username, password);
    browser = b;

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

    res.json({
      totalClasses: attendanceData.summary.totalDays,
      present: attendanceData.summary.presentDays,
      absent: attendanceData.summary.absentDays,
      attendancePercentage,
      daysNeeded,
      details: attendanceData.details
    });
  } catch (error) {
    console.error('Error in fetch-attendance:', error.message);
    res.status(500).json({ error: 'Failed to fetch attendance data: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.post('/fetch-class-attendance', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  let browser;
  try {
    const { browser: b, page } = await loginToSamvidha(username, password);
    browser = b;

    // Navigate to course content page
    await page.goto('https://samvidha.iare.ac.in/home?action=course_content', { waitUntil: 'networkidle2' });
    // Wait for the table or fallback to a longer wait
    try {
      await page.waitForSelector('table.table', { timeout: 10000 });
    } catch (e) {
      await page.waitForTimeout(3000); // fallback wait
    }
    // Scrape attendance data from the table
    const attendanceRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table.table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        return {
          date: cells[1]?.innerText.trim(),
          period: cells[2]?.innerText.trim(),
          topic: cells[3]?.innerText.trim(),
          status: cells[4]?.innerText.trim().toUpperCase()
        };
      });
    });

    // Aggregate attendance by topic
    const topicMap = {};
    attendanceRows.forEach(row => {
      const topic = row.topic || 'Unknown';
      if (!topicMap[topic]) {
        topicMap[topic] = { topic, total: 0, present: 0, absent: 0 };
      }
      topicMap[topic].total++;
      if (row.status === 'PRESENT') topicMap[topic].present++;
      if (row.status === 'ABSENT') topicMap[topic].absent++;
    });

    const classAttendanceData = Object.values(topicMap).map(topic => ({
      subjectName: topic.topic,
      totalClasses: topic.total,
      classesAttended: topic.present,
      percentage: topic.total > 0 ? ((topic.present / topic.total) * 100).toFixed(2) : 0,
      attendanceInfo: `${topic.present}/${topic.total} classes`,
      absent: topic.absent
    }));

    if (classAttendanceData.length === 0) {
      throw new Error('No attendance data found. Please check if you have access to the course content page.');
    }

    res.json({ classAttendanceData });
  } catch (error) {
    console.error('Error in fetch-class-attendance:', error.message);
    res.status(500).json({ error: 'Failed to fetch class attendance data: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Error handling middleware with detailed logging
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// Start server with error handling
const server = app.listen(port, () => {
  logger.info(`Server is running on port ${port} in ${process.env.NODE_ENV} mode`);
}).on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

// Graceful shutdown with timeout
const gracefulShutdown = async () => {
  logger.info('Received shutdown signal');
  
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
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
