# Attendance Calculator for Samvidha Portal

A web application to calculate attendance percentage and days needed to maintain 75% attendance by scraping data from the Samvidha portal (https://samvidha.iare.ac.in/).

## Features

- Automated attendance calculation
- Detailed attendance statistics
- Days needed to maintain 75% attendance
- Class-wise attendance breakdown
- Secure credential handling
- Responsive design

## Tech Stack

- **Backend:**
  - Node.js
  - Express.js
  - Puppeteer (for web scraping)
  - Winston (for logging)
  - Helmet (for security)

- **Frontend:**
  - HTML5
  - Tailwind CSS
  - JavaScript (Vanilla)

## Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Google Chrome (for Puppeteer)

## Local Development Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd attendance-calculator
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the backend directory with:
```env
NODE_ENV=development
PORT=3000
CHROME_BIN=/usr/bin/google-chrome
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
CORS_ORIGIN=http://localhost:3000
```

4. Start the development server:
```bash
npm run dev
```

5. Access the application at `http://localhost:3000`

## Production Deployment

The application is configured for deployment on Render. Follow these steps:

1. Fork this repository
2. Create a new Web Service on Render
3. Connect your repository
4. Set the following environment variables in Render:
   - `NODE_ENV=production`
   - `PORT=10000`
   - `CHROME_BIN=/usr/bin/google-chrome`
   - `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`
   - `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome`
   - `CORS_ORIGIN=https://your-app-name.onrender.com`

## Security Considerations

- Credentials are never stored on the server
- All requests are rate-limited
- CORS is properly configured
- Security headers are implemented
- HTTPS is enforced in production

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Samvidha Portal for the data source
- Puppeteer team for the web scraping capabilities
- Render for hosting

Dependencies

Backend: express, puppeteer, cors, dotenv
Frontend: Tailwind CSS (via CDN)

