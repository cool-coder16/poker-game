// tests/helpers.js — loads the game's plain <script> files into Node so they can be tested.
// The browser files share globals; vm.runInThisContext gives Node the same behavior.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(...files) {
  files.forEach(f => vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f }));
}

// A card from a code like "Ks", "10h", "As" (suits: s h d c, same as game.js)
function card(code) {
  const r = code.slice(0, -1);
  const rank = { J: 11, Q: 12, K: 13, A: 14 }[r] || Number(r);
  const s = ['s', 'h', 'd', 'c'].indexOf(code.slice(-1));
  return { r: rank, s, id: s * 13 + (rank - 2) };
}

// Build a deck that deals `codes` in order (the engine deals with deck.pop(), so reverse them)
function stack(codes) {
  const rigged = codes.map(card);
  const used = new Set(rigged.map(c => c.id));
  return makeDeck().filter(c => !used.has(c.id)).concat(rigged.reverse());
}

// A small seeded random generator so a failing test can be replayed exactly
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6D2B79F5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { load, card, stack, seeded };
