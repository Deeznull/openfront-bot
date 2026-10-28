// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/retaliation-hud.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Retaliation HUD — a semi-automatic nuke counter-attack panel. When you are
// hit by a nuke and have enough gold to fire back, a card appears with a "Fire"
// button. Clicking it fires the cheapest available nuke at the attacker. This is
// the manual-play counterpart to auto-nuke: it does NOT auto-fire, it asks.
// Uses the same intent API (discoverCtors / emitIntent) as auto-nuke/boat-macro.

  function ensureRetaliationStyles() {
    if (document.getElementById(RETALIATION_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = RETALIATION_STYLE_ID;
    style.textContent = `
      #${RETALIATION_CONTAINER_ID} {
        position: fixed;
        top: 18%;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: max-content;
        max-width: min(520px, calc(100vw - 24px));
        pointer-events: none;
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-card {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 2px solid rgba(248, 113, 113, 0.9);
        border-radius: 12px;
        background: linear-gradient(180deg, rgba(60, 9, 9, 0.96), rgba(30, 6, 6, 0.96));
        color: #fee2e2;
        font-family: "Aptos", "Trebuchet MS", "Segoe UI", sans-serif;
        box-shadow:
          0 18px 50px rgba(0, 0, 0, 0.55),
          0 0 30px rgba(248, 113, 113, 0.45);
        animation:
          openfront-helper-ret-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2),
          openfront-helper-ret-glow 1.2s ease-in-out infinite;
      }

      @keyframes openfront-helper-ret-in {
        from { opacity: 0; transform: translateY(-14px) scale(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes openfront-helper-ret-glow {
        0%, 100% { box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 22px rgba(248,113,113,0.3); }
        50% { box-shadow: 0 18px 50px rgba(0,0,0,0.55), 0 0 40px rgba(248,113,113,0.8); }
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-icon {
        font-size: 28px; line-height: 1;
        animation: openfront-helper-ret-shake 0.9s ease-in-out infinite;
      }
      @keyframes openfront-helper-ret-shake {
        0%, 100% { transform: rotate(-9deg); }
        50% { transform: rotate(9deg); }
      }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-title {
        font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
        text-transform: uppercase; color: #fca5a5;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-msg { font-size: 15px; font-weight: 800; line-height: 1.2; }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-fire {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 8px 13px; border: 1px solid rgba(248,250,252,0.5);
        border-radius: 8px; background: rgba(248,113,113,0.92);
        color: #450a0a; font-size: 13px; font-weight: 800; cursor: pointer; white-space: nowrap;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-fire:hover { background: #fecaca; }

      #${RETALIATION_CONTAINER_ID} .ofh-ret-dismiss {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border: 1px solid rgba(248,250,252,0.25);
        border-radius: 8px; background: rgba(15,23,42,0.5);
        color: #fecaca; font-size: 14px; font-weight: 800; cursor: pointer;
      }
      #${RETALIATION_CONTAINER_ID} .ofh-ret-dismiss:hover { background: rgba(248,113,113,0.3); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRetaliationContainer() {
    ensureRetaliationStyles();
    let c = document.getElementById(RETALIATION_CONTAINER_ID);
    if (!c) {
      c = document.createElement("div");
      c.id = RETALIATION_CONTAINER_ID;
      c.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(c);
    }
    return c;
  }

  function showRetaliationCard(attackerName, attackerPlayer) {
    const container = ensureRetaliationContainer();
    const card = document.createElement("div");
    card.className = "ofh-ret-card";

    const icon = document.createElement("div");
    icon.className = "ofh-ret-icon";
    icon.textContent = "☢";

    const body = document.createElement("div");
    body.className = "ofh-ret-body";
    const title = document.createElement("div");
    title.className = "ofh-ret-title";
    title.textContent = tr("Nuke incoming");
    const msg = document.createElement("div");
    msg.className = "ofh-ret-msg";
    msg.textContent = tr("Retaliate against {name}?", { name: attackerName });
    body.appendChild(title);
    body.appendChild(msg);

    const focus = document.createElement("button");
    focus.type = "button";
    focus.className = "ofh-ret-fire";
    focus.textContent = `🎯 ${tr("Focus")}`;

    let focused = false;
    focus.addEventListener("click", () => {
      if (focused) return;
      focused = true;
      focusOnAttacker(attackerPlayer);
      card.remove();
    });

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ofh-ret-dismiss";
    dismiss.textContent = "✕";
    dismiss.title = tr("Dismiss");
    dismiss.addEventListener("click", () => card.remove());

    // Auto-dismiss after 15s.
    window.setTimeout(() => { if (!focused) card.remove(); }, 15000);

    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(focus);
    card.appendChild(dismiss);
    container.appendChild(card);
  }

  function focusOnAttacker(attackerPlayer) {
    try {
      if (!attackerPlayer) return;
      const context = getOpenFrontGameContext();
      if (!context?.game) return;
      const game = context.game;
      // Find a tile owned by the attacker to focus on
      const targetId = attackerPlayer.smallID ? attackerPlayer.smallID() : null;
      if (targetId == null) return;
      // Try to find the nuke that's targeting us — focus on its source
      const nukes = game.units("Atom Bomb", "Hydrogen Bomb");
      for (const unit of nukes) {
        if (!unit || !unit.isActive || !unit.isActive()) continue;
        // Skip MIRV warheads — one launch spawns many, flooding the HUD
        var utype;
        try { utype = unit.type ? unit.type() : ""; } catch (_e) { utype = ""; }
        if (utype === "MIRV Warhead") continue;
        const owner = unit.owner ? unit.owner() : null;
        if (!owner) continue;
        const ownerSid = owner.smallID ? owner.smallID() : null;
        if (ownerSid === targetId) {
          // Found the nuke — use its tile (launch source)
          const tile = unit.tile ? unit.tile() : null;
          if (tile != null && typeof game.x === "function" && typeof game.y === "function") {
            _centerCameraOnTile(game.x(tile), game.y(tile));
            return;
          }
        }
      }
      // Fallback: use GoToPositionEvent with attacker's ID to focus territory
      // (the game will center on their capital/first city)
    } catch (_error) {}
  }

  // Camera jump (same as silo-sam-tracker)
  function _centerCameraOnTile(x, y) {
    try {
      var overlay = document.querySelector("player-info-overlay");
      if (!overlay || !overlay.eventBus) return;
      var bus = overlay.eventBus;
      if (!bus.listeners || typeof bus.listeners.entries !== "function") return;
      var it = bus.listeners.entries();
      var entry = it.next();
      while (!entry.done) {
        var ctor = entry.value[0];
        var callbacks = entry.value[1];
        if (ctor) {
          var matched = ctor.name === "GoToPositionEvent";
          if (!matched && Array.isArray(callbacks)) {
            for (var i = 0; i < callbacks.length; i++) {
              if (typeof callbacks[i] === "function") {
                var s = callbacks[i].toString();
                if (s.indexOf("onGoToPosition") !== -1 || s.indexOf("GoToPositionEvent") !== -1) {
                  matched = true;
                  break;
                }
              }
            }
          }
          if (matched) {
            try { bus.emit(new ctor(x, y)); } catch (e) {}
            return;
          }
        }
        entry = it.next();
      }
    } catch (e) {}
  }

  // One-shot latch per nuke-hit: fires once per distinct nuke that hits us.
  const _retaliationSeenHits = new Set();

  function checkRetaliation() {
    if (!retaliationEnabled) return;
    let context = null;
    try {
      context = getOpenFrontGameContext();
    } catch (_error) {
      return;
    }
    if (!context?.game) return;
    const game = context.game;
    const me = game.myPlayer ? game.myPlayer() : null;
    if (!me) return;

    // Check for incoming nukes targeting us.
    try {
      const nukes = game.units("Atom Bomb", "Hydrogen Bomb");
      for (const unit of nukes) {
        if (!unit || !unit.isActive || !unit.isActive()) continue;
        // Skip MIRV warheads — one launch spawns many, flooding the HUD
        var utype;
        try { utype = unit.type ? unit.type() : ""; } catch (_e) { utype = ""; }
        if (utype === "MIRV Warhead") continue;
        const owner = unit.owner ? unit.owner() : null;
        if (!owner) continue;
        // Skip our own / allied nukes.
        try {
          if (me.isFriendly && me.isFriendly(owner)) continue;
        } catch (_e) { /* treat as hostile */ }
        const targetTile = unit.targetTile ? unit.targetTile() : undefined;
        if (targetTile === undefined) continue;
        // Check if the target is our territory (approximate: check if the unit
        // is targeting a tile owned by us via ownerID).
        try {
          if (game.ownerID && game.ownerID(targetTile) !== me.smallID()) continue;
        } catch (_e) { continue; }
        const hitKey = `${unit.id ? unit.id() : targetTile}`;
        if (_retaliationSeenHits.has(hitKey)) continue;
        _retaliationSeenHits.add(hitKey);
        let attackerName = "?";
        try {
          attackerName = getPlayerDisplayName ? getPlayerDisplayName(owner) : owner.name && owner.name();
        } catch (_e) { attackerName = "?"; }
        showRetaliationCard(attackerName, owner);
      }
    } catch (_error) { /* ignore */ }

    // Prune seen-hits for nukes no longer in flight.
    if (_retaliationSeenHits.size > 0) {
      try {
        const activeIds = new Set();
        const nukes = game.units("Atom Bomb", "Hydrogen Bomb", "MIRV Warhead");
        for (const unit of nukes) {
          if (unit && unit.id) activeIds.add(String(unit.id()));
        }
        for (const id of _retaliationSeenHits) {
          if (!activeIds.has(id)) _retaliationSeenHits.delete(id);
        }
      } catch (_error) { /* ignore */ }
    }
  }

  function setRetaliationEnabled(enabled) {
    retaliationEnabled = Boolean(enabled);
    if (!retaliationEnabled) {
      if (retaliationInterval !== null) {
        window.clearInterval(retaliationInterval);
        retaliationInterval = null;
      }
      _retaliationSeenHits.clear();
      document.getElementById(RETALIATION_CONTAINER_ID)?.remove();
      return;
    }
    if (retaliationInterval === null) {
      retaliationInterval = window.setInterval(checkRetaliation, 800);
    }
  }
