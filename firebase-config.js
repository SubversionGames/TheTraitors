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
  host: ["SVTr3Main", "SVTr3Prod"],  // SVTr3Main = seated, SVTr3Prod = observer
  player: "Player2026"  // generic test password — shows name/pronoun modal
};

// Per-player passwords — each maps to pre-populated name and pronouns.
// Players using these skip the name modal and load into a seat directly.
// Add one entry per player. Passwords are case-sensitive.
// Format: "Password": { name: "DisplayName", pronouns: "they/them" }
const PLAYER_PRESETS = {
  "Alex714":  { name: "Alex",    pronouns: "he/him" },
  "Blake059":  { name: "Blake",    pronouns: "he/him" },
  "Bryce163":  { name: "Bryce",    pronouns: "he/him" },
  "Cara490":  { name: "Cara",    pronouns: "she/her" },
  "Dani331":  { name: "Dani",    pronouns: "she/her" },
  "Emily905":  { name: "Emily",    pronouns: "she/her" },
  "Jabbar647":  { name: "Jabbar",    pronouns: "he/him" },
  "Jake012":  { name: "Jake",    pronouns: "he/him" },
  "JB558":  { name: "JB",    pronouns: "she/her" },
  "Lis394":  { name: "Lis",    pronouns: "she/her" },
  "Mac720":  { name: "Mac",    pronouns: "they/she" },
  "Marco186":  { name: "Marco",    pronouns: "he/him" },
  "Monty933":  { name: "Monty",    pronouns: "he/him" },
  "Rachael401":  { name: "Rachael",    pronouns: "she/her" },
  "Reynolds679":  { name: "Reynolds",    pronouns: "he/him" },
  "Samm045":  { name: "Samm",    pronouns: "he/they" },
  "Sterling262":  { name: "Sterling",    pronouns: "she/they" },
  "Tamera591":  { name: "Tamera",    pronouns: "she/her" },
  "Taylor308": { name: "Taylor",  pronouns: "she/her" },
  "Trias750":   { name: "Trias",     pronouns: "he/him" },
  "Ty984":  { name: "Ty",    pronouns: "he/him" },
  "Yoli436":  { name: "Yoli",    pronouns: "she/her" },

  // Eliminated Players
  "Tricks129":  { name: "Tricks",    pronouns: "they/them" },
  "Simona817":  { name: "Simona",    pronouns: "she/her" },
  "Brian822":  { name: "Brian",    pronouns: "he/him" },
  "Ethan278":  { name: "Ethan",    pronouns: "he/him" }
};
window.playerPresets = PLAYER_PRESETS;

// Export for use in other files
window.gameDatabase = database;
window.gamePasswords = PASSWORDS;