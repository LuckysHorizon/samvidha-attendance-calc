/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./dashboard.html",
    "./js/**/*.js"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
} 