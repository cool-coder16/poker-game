// chat.js — the rules of table chat. Plain functions: no network, no screen.
//
// Chat lives in the database under chat/<room code>. The database rules (database.rules.json) are what really
// protect it: messages are at most 200 characters, each person can send one every 1.5 seconds, nobody can edit
// a message, the host can mute people, turn chat off and clear it. The code here makes the page behave the same
// way, so people get a friendly message instead of a silent failure.

const CHAT_MAX_LENGTH = 200;
const CHAT_COOLDOWN_MS = 2000;   // the database rules allow one message every 1.5 seconds; the page waits a little longer so network delays never trip the rule
const CHAT_SHOWN = 50;          // how many recent messages the page loads
const BLOCKED_KEY = 'pokerBlockedChatters';

// Tidy what someone typed: no control characters, one space between words, trimmed, and not too long.
// Returns '' if there is nothing worth sending.
function cleanChatText(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')    // control characters (newlines, tabs, ...) become spaces
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH)
    .trim();
}

// How many milliseconds until you may send again (0 = go ahead)
function chatCooldownLeft(lastSentAt, now = Date.now()) {
  return Math.max(0, CHAT_COOLDOWN_MS - (now - (lastSentAt || 0)));
}

// Can you chat right now? Returns { ok: true } or { ok: false, reason } to show in the box.
function chatAllowed(meta, muted, myId) {
  if (meta && meta.chat === false) return { ok: false, reason: 'The host turned chat off.' };
  if (muted && muted[myId]) return { ok: false, reason: 'The host muted you.' };
  return { ok: true };
}

// Messages without the people you blocked (a blocked person's messages stay hidden only for you)
function chatVisible(messages, blocked) {
  const set = new Set(blocked || []);
  return (messages || []).filter(m => !set.has(m.uid));
}

// Your block list lives in this browser only
function loadBlocked() {
  try { return JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]'); } catch (err) { return []; }
}
function saveBlocked(list) {
  try { localStorage.setItem(BLOCKED_KEY, JSON.stringify(list)); } catch (err) { /* storage unavailable: ignore */ }
}
