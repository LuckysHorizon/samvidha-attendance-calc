Attendance Calculator for Samvidha Portal
A web application to calculate attendance percentage and days needed to maintain 75% attendance by scraping data from the Samvidha portal (https://samvidha.iare.ac.in/).
File Structure
attendance-calculator/
├── backend/
│   ├── node_modules/
│   ├── package.json
│   ├── server.js
│   └── .env
├── frontend/
│   └── index.html
├── .gitignore
└── README.md

Prerequisites

Node.js and npm
VS Code
Google Chrome (for Puppeteer)

Setup Instructions

Clone the repository:
git clone <repository-url>
cd attendance-calculator


Set up backend:
cd backend
npm install

Create a .env file with:
PORT=3000


Run backend:
npm start


Serve frontend:

Open frontend/index.html in VS Code.
Use the Live Server extension (right-click index.html > Open with Live Server) or serve via:npx serve frontend




Access the application:

Open http://localhost:5500 (or the Live Server port) in a browser.
Enter Samvidha credentials to view attendance details.



Notes

Update selectors in server.js based on the Samvidha portal's HTML structure.
Ensure compliance with the portal's terms of service for web scraping.
Deploy to Heroku/Vercel for production use.

Dependencies

Backend: express, puppeteer, cors, dotenv
Frontend: Tailwind CSS (via CDN)

