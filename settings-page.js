// settings-page.js — show the saved settings, and save them again whenever one changes.

const optSb = $('optSb'), optStack = $('optStack'), optSpeed = $('optSpeed');
const optAuto = $('optAuto'), optRebuy = $('optRebuy');

// Fill the form from the saved settings
function showSettings(s) {
  optSb.value = String(s.sb);
  optStack.value = String(s.startChips);
  optSpeed.value = String(s.speed);
  optAuto.checked = s.autoDeal;
  optRebuy.checked = s.botRebuy;
}

// Read the form back into a settings object and save it
function saveFromForm() {
  saveSettings({
    sb: Number(optSb.value),
    startChips: Number(optStack.value),
    speed: Number(optSpeed.value),
    autoDeal: optAuto.checked,
    botRebuy: optRebuy.checked,
  });
  const note = $('savedNote');
  note.textContent = 'Saved ✓';
  setTimeout(() => { note.textContent = ''; }, 1500);
}

[optSb, optStack, optSpeed, optAuto, optRebuy].forEach(el => { el.onchange = saveFromForm; });

$('btnReset').onclick = () => {
  showSettings(DEFAULT_SETTINGS);
  saveFromForm();
};

showSettings(loadSettings());
