// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyAXU44lHWMQlAYF9m8fi3cKg_Bo-3OwqL0",
  authDomain: "subversion-the-traitors.firebaseapp.com",
  projectId: "subversion-the-traitors",
  storageBucket: "subversion-the-traitors.firebasestorage.app",
  messagingSenderId: "119241773958",
  appId: "1:119241773958:web:7cddc5f72f9be96458d207"
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
