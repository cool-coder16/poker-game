// menu.js — the main menu has almost no logic: just a line about the current season.

function updateSeasonLine() {
  $('seasonLine').textContent = `${seasonLabel(seasonId())} · season ends in ${timeLeftText()}`;
}
updateSeasonLine();
setInterval(updateSeasonLine, 60000);   // keep the countdown fresh if the page stays open
