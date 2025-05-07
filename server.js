const express = require('express');
const path = require('path');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// API Routes
app.post('/fetch-class-attendance', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // TODO: Add your actual authentication and data fetching logic here
    // This is just a placeholder response
    res.json({
      classAttendanceData: [
        {
          subjectName: "Mathematics",
          date: "2024-03-20",
          percentage: 85,
          attendanceInfo: "17/20 classes",
          classesAttended: 17,
          totalClasses: 20,
          absent: 3
        }
        // Add more subjects as needed
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 