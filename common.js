// common.js — small helpers shared by every page. Load this first.

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString();

// ---------- Settings (saved in this browser; edited on settings.html, read by play.html) ----------
const SETTINGS_KEY = 'pokerSettings';
const DEFAULT_SETTINGS = { sb: 10, startChips: 1000, speed: 1, autoDeal: false, botRebuy: true };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch (err) {
    return { ...DEFAULT_SETTINGS };   // storage blocked or corrupted: just use the defaults
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (err) { /* ignore */ }
}

// ---------- Waiting for Firebase ----------
// auth.js is a module, so it finishes loading after the normal scripts. It fires this event when ready.
function whenAuthReady() {
  if (window.pokerAuth) return Promise.resolve();
  return new Promise(resolve => window.addEventListener('pokerauth-ready', resolve, { once: true }));
}
