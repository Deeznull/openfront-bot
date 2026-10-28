// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/auto-donate.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Changed: an empty target list means "every friendly human player (teammate or
// ally)" instead of "nobody"; sendGamePacket is the shim in 00-shims.js (sends
// through the bot's rate-limited intent path, not the WebSocket); settings come
// from the shimmed _quickPanelSettingsCache (defaults in 00-shims.js).

// Auto-donate engine — troops and gold to named players.
// Settings-driven: reads thresholds, percentages, and target player names from
// Quick Panel settings cache. Runs on the shared helper tick (1s interval).
//
// Troop logic:  if currentTroops > maxTroops * (keepPct/100) → donate (currentTroops * donatePct/100)
// Gold logic:   if currentGold > maxGoldThreshold → donate (currentGold * donatePct/100)
//
// Target matching: comma-separated player names (case-insensitive, includes clan tags).

(function initAutoDonate() {

  var _lastDonateTroopsMs = 0;
  var _lastDonateGoldMs = 0;
  var DONATE_COOLDOWN_MS = 3000;

  function _cfg(key, fallback) {
    try {
      if (typeof _quickPanelSettingsCache === "object" && _quickPanelSettingsCache && key in _quickPanelSettingsCache)
        return _quickPanelSettingsCache[key];
    } catch (e) {}
    return fallback;
  }

  function _parseTargets(raw) {
    if (!raw || typeof raw !== "string") return [];
    var parts = raw.split(",");
    var result = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim().toLowerCase();
      if (name) result.push(name);
    }
    return result;
  }

  function _matchPlayer(player, targetNames) {
    if (!player || targetNames.length === 0) return false;
    var displayName = "";
    try {
      displayName = String(
        (typeof player.displayName === "function" ? player.displayName() : null) ??
        (typeof player.name === "function" ? player.name() : null) ??
        (player.data && player.data.displayName) ??
        (player.data && player.data.name) ??
        ""
      ).toLowerCase();
    } catch (e) { return false; }
    if (!displayName) return false;
    for (var i = 0; i < targetNames.length; i++) {
      if (displayName.indexOf(targetNames[i]) !== -1) return true;
    }
    return false;
  }

  // ofbot: default target set when no names are configured.
  function _isFriendlyHuman(me, player) {
    try {
      if (typeof isNationBotPlayer === "function" && isNationBotPlayer(player)) return false;
      return !!(me.isFriendly && me.isFriendly(player));
    } catch (e) { return false; }
  }

  function _isInCombat(player) {
    try {
      var incoming = typeof player.incomingAttacks === "function" ? player.incomingAttacks() : [];
      var outgoing = typeof player.outgoingAttacks === "function" ? player.outgoingAttacks() : [];
      return (incoming && incoming.length > 0) || (outgoing && outgoing.length > 0);
    } catch (e) { return false; }
  }

  function _troopPercentage(player, game) {
    try {
      var troops = Number(player.troops ? player.troops() : 0);
      var max = 1;
      if (game && typeof game.config === "function" && typeof game.config().maxTroops === "function")
        max = game.config().maxTroops(player);
      if (max <= 0) max = 1;
      return troops / max;
    } catch (e) { return 0; }
  }

  function _findTargetPlayers(game, me, targetNames, combatOnly) {
    var matches = [];
    if (!game || !me) return matches; // ofbot: no names = friendly players
    try {
      var players = typeof game.players === "function" ? game.players() : [];
      for (var i = 0; i < players.length; i++) {
        var p = players[i];
        if (!p) continue;
        try {
          if (!p.isAlive || !p.isAlive()) continue;
          var mySid = me.smallID ? me.smallID() : null;
          var pSid = p.smallID ? p.smallID() : null;
          if (mySid !== null && pSid !== null && mySid === pSid) continue;
          if (targetNames.length === 0 ? !_isFriendlyHuman(me, p) : !_matchPlayer(p, targetNames)) continue;
          // If combatOnly: skip players who are at peace
          if (combatOnly && !_isInCombat(p)) continue;
          matches.push(p);
        } catch (e) {}
      }
    } catch (e) {}
    return matches;
  }

  function _formatGold(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  // ---- Auto-donate troops ----

  function tickDonateTroops() {
    var enabled = _cfg("autoDonateEnabled", false);
    if (!enabled) return;

    var now = Date.now();
    if (now - _lastDonateTroopsMs < DONATE_COOLDOWN_MS) return;

    var ctx;
    try { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); } catch (e) {}
    if (!ctx || !ctx.game) return;

    var game = ctx.game;
    var me = game.myPlayer ? game.myPlayer() : null;
    if (!me || !me.isAlive || !me.isAlive()) return;

    // Check if donate is allowed in this game
    try {
      var cfg = typeof game.config === "function" ? game.config() : null;
      if (cfg && typeof cfg.donateTroops === "function" && cfg.donateTroops() === false) return;
    } catch (e) {}

    var keepPct = Number(_cfg("autoDonateKeepPct", 40)) || 40;
    var donatePct = Number(_cfg("autoDonatePercentage", 25)) || 25;
    var targetRaw = _cfg("autoDonateTargets", "");
    var targetNames = _parseTargets(targetRaw);


    var currentTroops = Number(me.troops ? me.troops() : 0);
    var maxTroops = 1;
    try { maxTroops = typeof game.config === "function" && typeof game.config().maxTroops === "function" ? game.config().maxTroops(me) : 1; } catch (e) {}
    if (maxTroops <= 0) maxTroops = 1;

    var keepAmount = maxTroops * (keepPct / 100);
    if (currentTroops <= keepAmount) return;

    var donateAmount = Math.floor(currentTroops * (donatePct / 100));
    if (donateAmount <= 0) return;

    // Find matching teammates who are IN COMBAT (attacking or being attacked)
    var targets = _findTargetPlayers(game, me, targetNames, true);
    if (targets.length === 0) return;

    // Pick the neediest (lowest troop %) among combat targets
    var best = null;
    var bestPct = Infinity;
    for (var i = 0; i < targets.length; i++) {
      try {
        var pct = _troopPercentage(targets[i], game);
        if (pct < bestPct) { bestPct = pct; best = targets[i]; }
      } catch (e) {}
    }
    if (!best) return;

    // Send donate packet
    var recipientId = best.id ? best.id() : (best.smallID ? best.smallID() : null);
    if (recipientId == null) return;
    try {
      sendGamePacket({ type: "donate_troops", recipient: recipientId, troops: donateAmount });
      _lastDonateTroopsMs = now;
      var name = (typeof getPlayerDisplayName === "function") ? getPlayerDisplayName(best) : "ally";
      console.log("[AutoDonate] troops", donateAmount, "→", name);
    } catch (e) {}
  }

  // ---- Auto-donate gold ----

  function tickDonateGold() {
    var enabled = _cfg("autoDonateGoldEnabled", false);
    if (!enabled) return;

    var now = Date.now();
    if (now - _lastDonateGoldMs < DONATE_COOLDOWN_MS) return;

    var ctx;
    try { ctx = (typeof getOpenFrontGameContext === "function" ? getOpenFrontGameContext() : null); } catch (e) {}
    if (!ctx || !ctx.game) return;

    var game = ctx.game;
    var me = game.myPlayer ? game.myPlayer() : null;
    if (!me || !me.isAlive || !me.isAlive()) return;

    var maxGold = Number(_cfg("autoDonateGoldThreshold", 5000000)) || 5000000;
    var donatePct = Number(_cfg("autoDonateGoldPercentage", 25)) || 25;
    var targetRaw = _cfg("autoDonateGoldTargets", "");
    var targetNames = _parseTargets(targetRaw);


    var currentGold = 0;
    try { currentGold = typeof me.gold === "function" ? Number(me.gold()) : 0; } catch (e) {}
    if (currentGold <= maxGold) return;

    var donateAmount = Math.floor(currentGold * (donatePct / 100));
    if (donateAmount <= 0) return;

    // Find matching players (gold can go to allies, not just teammates)
    var targets = _findTargetPlayers(game, me, targetNames);
    if (targets.length === 0) return;

    // Pick the poorest
    var best = null;
    var bestGold = Infinity;
    for (var i = 0; i < targets.length; i++) {
      try {
        var g = typeof targets[i].gold === "function" ? Number(targets[i].gold()) : 0;
        if (g < bestGold) { bestGold = g; best = targets[i]; }
      } catch (e) {}
    }
    if (!best) return;

    var recipientId = best.id ? best.id() : (best.smallID ? best.smallID() : null);
    if (recipientId == null) return;
    try {
      sendGamePacket({ type: "donate_gold", recipient: recipientId, gold: donateAmount });
      _lastDonateGoldMs = now;
      var name = (typeof getPlayerDisplayName === "function") ? getPlayerDisplayName(best) : "ally";
      console.log("[AutoDonate] gold", _formatGold(donateAmount), "→", name);
    } catch (e) {}
  }

  // ---- Global tick entry point ----

  window.__OFH_tickAutoDonate = function() {
    try { tickDonateTroops(); } catch (e) {}
    try { tickDonateGold(); } catch (e) {}
  };

})();
