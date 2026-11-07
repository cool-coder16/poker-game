// rooms.js — the Rooms page: make a room, or join one with a code.
// room-net.js (via window.pokerRooms) does the talking to the database.

let roomsProfile = null;

function setView(name) {
  ['needSignIn', 'notReady', 'roomForms'].forEach(id => $(id).classList.toggle('hidden', id !== name));
}

async function ready(user, prof) {
  roomsProfile = prof;
  if (!user) return setView('needSignIn');
  if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
  setView(window.pokerRooms.configured ? 'roomForms' : 'notReady');
}

function showError(text) { $('roomsError').textContent = text; }

async function createRoom() {
  showError('');
  $('btnCreate').disabled = true;
  try {
    const net = window.pokerRooms.makeNet();
    const code = await net.createRoom({
      hostName: roomsProfile.displayName, startChips: 1000, sb: 10, turnSeconds: 30,
      rising: false, handsPerLevel: 10, allowBots: true,
    });
    location.href = `room.html?code=${code}`;
  } catch (err) {
    showError(err.message || String(err));
    $('btnCreate').disabled = false;
  }
}

async function joinRoom(e) {
  e.preventDefault();
  showError('');
  const code = normalizeCode($('joinCode').value);
  if (code.length < 4) return showError('Type the room code your friend gave you.');
  try {
    const room = await window.pokerRooms.makeNet().getRoom(code);
    if (!room || !room.meta) return showError(`There is no room with the code ${code}.`);
    location.href = `room.html?code=${code}`;
  } catch (err) {
    showError(/permission/i.test(err.message || '') ? "Couldn't open that room. Is the code right?" : (err.message || String(err)));
  }
}

$('btnSignIn').onclick = openAuthDialog;
$('btnCreate').onclick = createRoom;
$('joinForm').onsubmit = joinRoom;
onAuth(ready);
