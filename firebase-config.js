// Firebase Configuration
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project.firebaseio.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Game passwords
const PASSWORDS = {
  host: "SVTr3",      // Change this to your host password
  player: "Player2026"     // Change this to your player password
};

// Export for use in other files
window.gameDatabase = database;
window.gamePasswords = PASSWORDS;
