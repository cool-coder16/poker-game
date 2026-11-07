// firebase-config.js — connection settings for the "poker-night-16" Firebase project.
//
// These values are NOT secrets. A Firebase *web* config only says which project to talk to;
// what actually protects the data is the security rules: firestore.rules (profiles, usernames,
// leaderboards) and database.rules.json (online rooms). Never put an admin/service-account key here.
const firebaseConfig = {
  databaseURL: "https://poker-night-16-default-rtdb.firebaseio.com",   // the Realtime Database used by online rooms
  apiKey: "AIzaSyD8CLSZD23wzIhBemOsuT0ovoDOYNuAPS8",
  authDomain: "poker-night-16.firebaseapp.com",
  projectId: "poker-night-16",
  storageBucket: "poker-night-16.firebasestorage.app",
  messagingSenderId: "670489605048",
  appId: "1:670489605048:web:e499f0a97bc491b135954d",
};
