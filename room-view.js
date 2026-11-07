// room-view.js — turns the table state the host publishes into what table-ui.js draws.
// Pure (no screen, no network) so it can be tested. Uses cardFromId from engine.js.
//
// The database drops empty arrays and nulls, so a published state can be missing `board`, `hole`,
// `result` and so on. Everything here reads those with a fallback.

// My seat goes at the bottom of the table, so the list starts with me.
function tableFromState(view, myId, myPrivate) {
  const seats = view.seats || [];
  const mine = Math.max(0, seats.findIndex(s => s.id === myId));
  const ordered = seats.slice(mine).concat(seats.slice(0, mine));
  // My cards only count if they are for this hand (an old hand's cards may still be stored)
  const myHole = myPrivate && myPrivate.handNo === view.handNo ? (myPrivate.hole || []).map(cardFromId) : [];
  const result = view.result || null;

  const list = ordered.map(s => {
    const out = !s.inHand && s.chips === 0;   // busted: sits out
    return {
      id: s.id, name: s.name, avatar: s.avatar, color: s.color, isHuman: s.id === myId,
      chips: s.chips, bet: s.bet || 0, totalBet: s.totalBet || 0, folded: Boolean(s.folded) || out, allIn: Boolean(s.allIn),
      status: out ? 'Out' : s.status || '', statusClass: out ? 's-fold' : s.statusClass || '', showCards: Boolean(s.showCards),
      // Others' cards show as backs (id -1 is a placeholder), mine only once they have arrived, a showdown shows real cards
      hole: s.showCards ? (s.hole || []).map(cardFromId)
        : s.id === myId ? myHole
        : Array.from({ length: s.holeCount || 0 }, () => ({ id: -1 })),
    };
  });

  const handOver = view.phase === 'hand-over';
  return {
    list,
    board: (view.board || []).map(cardFromId),
    markers: { dealer: view.dealer || null, sb: view.sbSeat || null, bb: view.bbSeat || null },
    activeId: view.toAct || null,
    winnerIds: new Set(handOver && result ? (result.winners || []).map(w => w.id) : []),
    handActive: view.phase !== 'hand-over' && view.phase !== 'waiting',
    message: handOver && result
      ? (result.winners || []).map(w => `${w.name} wins ${w.amount.toLocaleString()}${w.hand ? ' with ' + w.hand : ''}`).join(' · ')
      : { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' }[view.phase] || '',
  };
}
