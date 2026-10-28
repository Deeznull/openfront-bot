// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/attack-highlight.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Attack-highlight overlay — a map-scheduler layer that flags who is attacking
// you: a pulsing red ring around each attacker, a dashed line from them to your
// territory, and the total incoming troop count. Reads me.incomingAttacks()
// (plain { troops, attackerID, retreating } objects) and resolves attackers via
// game.playerBySmallID. Teammates/allies are skipped.

  let _attackHighlightScan = null; // { myLoc, attackers:[{loc, troops}], total }

  function scanAttackHighlight(game) {
    const me = game.myPlayer ? game.myPlayer() : null;
    if (!me) {
      _attackHighlightScan = null;
      return;
    }
    let myLoc = null;
    try {
      myLoc = me.nameLocation ? me.nameLocation() : null;
    } catch (_error) {
      myLoc = null;
    }
    let atks = null;
    try {
      atks = me.incomingAttacks ? me.incomingAttacks() : null;
    } catch (_error) {
      atks = null;
    }
    if (!atks || atks.length === 0) {
      _attackHighlightScan = { myLoc, attackers: [], total: 0 };
      return;
    }

    const byAttacker = new Map();
    let total = 0;
    for (let i = 0; i < atks.length; i += 1) {
      const a = atks[i];
      if (!a || a.retreating) {
        continue;
      }
      const troops = Number(a.troops) || 0;
      total += troops;
      const sid = a.attackerID;
      byAttacker.set(sid, (byAttacker.get(sid) || 0) + troops);
    }

    const attackers = [];
    byAttacker.forEach((troops, sid) => {
      let attacker = null;
      try {
        attacker = game.playerBySmallID ? game.playerBySmallID(sid) : null;
      } catch (_error) {
        attacker = null;
      }
      if (!attacker) {
        return;
      }
      // Skip friendly fire (teammates/allies shouldn't be flagged as threats).
      try {
        if (me.isFriendly && me.isFriendly(attacker)) {
          return;
        }
      } catch (_error) {
        /* treat as hostile */
      }
      let loc = null;
      try {
        loc = attacker.nameLocation ? attacker.nameLocation() : null;
      } catch (_error) {
        loc = null;
      }
      if (loc) {
        attackers.push({ loc, troops });
      }
    });

    _attackHighlightScan = { myLoc, attackers, total };
  }

  function drawAttackHighlight(ctx, game, transform, now) {
    const scan = _attackHighlightScan;
    if (!scan || scan.attackers.length === 0) {
      return;
    }
    const myScreen = scan.myLoc
      ? mapWorldToScreen(transform, scan.myLoc.x, scan.myLoc.y)
      : null;
    // Pulse 0..1 for the ring radius/alpha.
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);

    ctx.save();
    for (let i = 0; i < scan.attackers.length; i += 1) {
      const atk = scan.attackers[i];
      const p = mapWorldToScreen(transform, atk.loc.x, atk.loc.y);
      if (!p || !mapPointOnScreen(p.x, p.y, 60)) {
        continue;
      }
      // Line attacker → my territory.
      if (myScreen) {
        ctx.beginPath();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(248, 113, 113, 0.55)";
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(myScreen.x, myScreen.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Pulsing ring.
      const r = 14 + pulse * 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(248, 113, 113, ${0.5 + pulse * 0.45})`;
      ctx.stroke();
    }

    // Total-incoming label near my territory.
    if (myScreen && scan.total > 0) {
      drawMapHaloText(
        ctx,
        myScreen.x,
        myScreen.y - 22,
        `⚔ ${troopsDisplay(scan.total)}`,
        "rgba(254, 202, 202, 0.98)",
      );
    }
    ctx.restore();
  }

  registerMapOverlayLayer({
    id: "attack-highlight",
    scanIntervalMs: 400,
    animated: true, // pulsing rings animate off `now` — must redraw every frame
    isEnabled: function () {
      return attackHighlightEnabled;
    },
    scan: function (game) {
      scanAttackHighlight(game);
    },
    draw: function (ctx, game, transform, now) {
      drawAttackHighlight(ctx, game, transform, now);
    },
  });

  function setAttackHighlightEnabled(enabled) {
    attackHighlightEnabled = Boolean(enabled);
    if (!attackHighlightEnabled) {
      _attackHighlightScan = null;
    }
    requestMapOverlayLoop();
  }
