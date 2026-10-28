// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/name-overlay.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing. ofbot change: the troops pill shows current/max, colored
// against your own troops (±10% yellow, fewer red, more green).

// Per-player on-map overlay — a single layer on the shared map-overlay scheduler
// that draws, above each living player's name:
//   • a troop RATIO BAR (home = relation color, attacking = orange, bg = max)
//     plus the /10 troop count            — toggle: showMapTroopCounts
//   • threat marks: ☢ nuke-capable icon,  — toggle: showThreatIndicators
//     red "stronger than you" dot, amber "weak" dot (enemies only)
//   • gold readout                        — toggle: showMapMoney
// Colored by relation (blue=you, teal=team, green=ally, red=enemy). One scan
// (throttled) feeds everything; the per-frame draw maps nameLocation → screen.
//
// IMPORTANT: OpenFront stores troops at 10x internally and the UI renders /10
// (see gold-per-minute.js renderTroops). Ratios (troops/max) are scale-invariant,
// but any DISPLAYED absolute troop number must be divided by 10.

  function formatMapTroops(value) {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    if (v >= 1e6) {
      return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    }
    if (v >= 1e3) {
      return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    }
    return String(v);
  }

  // Display helper: raw internal troops (10x) → shown value.
  function troopsDisplay(rawTroops) {
    return formatMapTroops((Number(rawTroops) || 0) / 10);
  }

  function formatMapGold(value) {
    const v = Math.max(0, Math.floor(Number(value) || 0));
    if (v >= 1e6) {
      return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    }
    if (v >= 1e3) {
      return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    }
    return `$${v}`;
  }

  // ofbot: money colour by what the gold buys. Gray: not a Hydrogen Bomb;
  // yellow: a Hydrogen Bomb; bold gold with a glow: a MIRV. Costs come from the
  // game config when it can price them, else the v0.35.6 base costs (the
  // client view can't count MIRVs already launched, so MIRV may read 25M).
  var HBOMB_COST_FALLBACK = 5e6;
  var MIRV_COST_FALLBACK = 25e6;

  function nukeCost(game, player, type, fallback) {
    try {
      var c = Number(game.config().unitInfo(type).cost(game, player));
      if (Number.isFinite(c) && c > 0) {
        return c;
      }
    } catch (_error) { /* use the fallback */ }
    return fallback;
  }

  function moneyStyle(game, player, gold) {
    var g = Number(gold) || 0;
    if (g >= nukeCost(game, player, "MIRV", MIRV_COST_FALLBACK)) {
      return { rgb: "255, 191, 0", weight: "900", glow: true };
    }
    if (g >= nukeCost(game, player, "Hydrogen Bomb", HBOMB_COST_FALLBACK)) {
      return { rgb: "250, 224, 71", weight: "bold", glow: false };
    }
    return { rgb: "156, 163, 175", weight: "bold", glow: false };
  }

  function drawMoneyText(ctx, text, x, y, ms) {
    ctx.fillStyle = "rgba(" + ms.rgb + ", 0.98)";
    if (ms.glow) {
      ctx.shadowColor = "rgba(255, 191, 0, 0.85)";
      ctx.shadowBlur = 4;
    }
    ctx.fillText(text, x, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  function playerOverlayEnabled() {
    return (
      playerMapOverlaysEnabled &&
      (mapTroopCountsEnabled || threatIndicatorsEnabled || mapMoneyEnabled)
    );
  }

  // Scan cache: [{ player, relation, isEnemy, troops, inCombat, maxTroops, gold, threat }].
  // troops/inCombat/maxTroops are RAW (10x); divide by 10 only when displaying.
  let _playerOverlayScan = [];

  function scanPlayerOverlay(game) {
    // Skip overlay during spawn phase — many players crowd the screen and
    // overlays add cost with little value. Uses the game's own spawn-phase
    // detection (game.inSpawnPhase()) instead of heuristics.
    try {
      if (game?.inSpawnPhase?.()) {
        _playerOverlayScan = [];
        return;
      }
    } catch (_error) { /* ignore */ }

    const players = getCachedPlayerViews(game);
    const me = game.myPlayer ? game.myPlayer() : null;
    const nukeBuilders = threatIndicatorsEnabled ? advNukeBuilderIds(game) : null;
    const needBar = mapTroopCountsEnabled;
    const out = [];
    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      if (!player || !player.isAlive || !player.isAlive()) {
        continue;
      }
      let relation = "enemy";
      try {
        relation = getPlayerRelationToMyPlayer(game, player) || "enemy";
      } catch (_error) {
        relation = "enemy";
      }
      const isEnemy =
        relation !== "self" && relation !== "ally" && relation !== "team";
      const troops = advTroops(player);

      // Skip regular bots for troop bar + money overlays (too many early game).
      // Keep for human players AND nation AI (isNationBotPlayer).
      // PlayerType.Bot = "BOT" (portutil.js:28).
      const isRegularBot =
        isEnemy &&
        typeof isNationBotPlayer === "function" &&
        !isNationBotPlayer(player) &&
        player.type && player.type() === "BOT";

      const entry = {
        player,
        relation,
        isEnemy,
        troops,
        skipOverlay: isRegularBot,
        inCombat: (needBar && !isRegularBot) ? advTroopsInCombat(player) : 0,
        maxTroops: (needBar || threatIndicatorsEnabled) && !isRegularBot ? advMaxTroops(game, player) : 0,
        gold: (mapMoneyEnabled && !isRegularBot) ? advGoldNumber(player) : 0,
        threat: null,
      };
      if (threatIndicatorsEnabled && isEnemy && me) {
        try {
          entry.threat = advEvaluateThreat(game, me, player, nukeBuilders);
        } catch (_error) {
          entry.threat = null;
        }
      }
      out.push(entry);
    }
    _playerOverlayScan = out;
  }

  // Money readout with a dark rounded-pill background (Tactical-style), centered
  // above the player's name. Bigger + a coin icon so it reads clearly on the map.
  // Dynamic font sizing (Blon-inspired): scale money/troop bar with camera zoom
  // so overlays stay readable. Cull when the screen-space size drops below 5px.
  var _DYN_FONT_BASE = 36;
  var _DYN_FONT_SCALE = 48;
  var _DYN_SIZE_FACTOR = 0.4;
  var _DYN_NAME_SCALE_FACTOR = 0.25;
  var _DYN_SCALE_CAP = 3;
  var _DYN_MONEY_SIZE_MUL = 0.36;
  var _DYN_TROOP_BAR_SIZE_MUL = 0.2;
  var _DYN_MIN_SCREEN_PX = 5;

  function _getDynamicSizes(loc, transform) {
    var baseSize = Math.max(1, Math.floor(loc.size || 16));
    var nameScale = Math.min(baseSize * _DYN_NAME_SCALE_FACTOR, _DYN_SCALE_CAP);
    var nameWorldSize = Math.max(4, Math.floor(baseSize * _DYN_SIZE_FACTOR));
    var lineH_world = _DYN_FONT_BASE * (nameWorldSize * nameScale / _DYN_FONT_SCALE);
    var cameraScale = Number(transform.scale) || 1.8;
    var nameScreenPx = lineH_world * cameraScale;
    var moneyFontSize = Math.max(5, Math.floor(nameScreenPx * _DYN_MONEY_SIZE_MUL));
    var troopBarH = Math.max(2, Math.floor(nameScreenPx * _DYN_TROOP_BAR_SIZE_MUL));
    var troopBarW = Math.max(16, Math.floor(moneyFontSize * 3.5));
    // Tighter spacing: money pill closer to troop bar.
    var moneyOffsetY = Math.max(9, Math.floor(nameScreenPx * 0.8));
    var troopOffsetY = Math.max(5, Math.floor(nameScreenPx * 0.54));
    // Fade background when zoomed close to see the map.
    var zoomFade = nameScreenPx > 30 ? Math.max(0.4, 1.0 - (nameScreenPx - 30) / 80) : 1.0;
    var pillBgAlpha = (0.6 * zoomFade).toFixed(2);
    var pillBdAlpha = (0.22 * zoomFade).toFixed(2);
    var barBgAlpha = (0.5 * zoomFade).toFixed(2);
    return {
      moneyFontSize: moneyFontSize, troopBarW: troopBarW, troopBarH: troopBarH,
      moneyOffsetY: moneyOffsetY, troopOffsetY: troopOffsetY,
      visible: nameScreenPx >= _DYN_MIN_SCREEN_PX,
      screenPx: nameScreenPx,
      pillBgAlpha: pillBgAlpha, pillBdAlpha: pillBdAlpha, barBgAlpha: barBgAlpha,
    };
  }

  function drawMoneyPill(ctx, cx, cy, text, dyn, ms) {
    var fs = dyn.moneyFontSize;
    ctx.font = ms.weight + ' ' + fs + 'px "Aptos", "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = Math.max(1, fs * 0.25);
    var tw = ctx.measureText(text).width;
    var w = tw + 6;
    var h = Math.max(10, fs + 3);
    var x0 = cx - w / 2;
    var y0 = cy - h / 2;
    fillRoundRect(ctx, x0, y0, w, h, 4, "rgba(7, 12, 18, " + dyn.pillBgAlpha + ")", "rgba(" + ms.rgb + ", " + dyn.pillBdAlpha + ")");
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    drawMoneyText(ctx, text, cx, cy + 0.5, ms);
  }

  // ofbot: "current/max" troops. Current is colored against your current
  // troops and max against your max: within ±10% yellow, fewer red, more
  // green; your own label stays blue.
  function troopPillLabel(troops, maxTroops) {
    return troopsDisplay(troops) + "/" + troopsDisplay(maxTroops);
  }

  function troopCompareColor(relation, value, mine) {
    if (relation === "self") {
      return "95, 178, 255";
    }
    var ratio = value / Math.max(1, mine);
    if (ratio < 0.9) {
      return "248, 113, 113";
    }
    if (ratio > 1.1) {
      return "74, 222, 128";
    }
    return "250, 204, 21";
  }

  // Draws "current/max" left-aligned from x, each number in its own color.
  function drawTroopParts(ctx, x, cy, troops, maxTroops, rgb) {
    var cur = troopsDisplay(troops);
    var slash = "/";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(" + rgb.cur + ", 0.98)";
    ctx.fillText(cur, x, cy + 0.5);
    x += ctx.measureText(cur).width;
    ctx.fillStyle = "rgba(203, 213, 225, 0.9)";
    ctx.fillText(slash, x, cy + 0.5);
    x += ctx.measureText(slash).width;
    ctx.fillStyle = "rgba(" + rgb.max + ", 0.98)";
    ctx.fillText(troopsDisplay(maxTroops), x, cy + 0.5);
    ctx.textAlign = "center";
  }

  // Troops pill (shown above the troop bar when the money readout is off).
  function drawMaxTroopPill(ctx, cx, cy, maxTroops, dyn, troops, rgb) {
    var fs = dyn.moneyFontSize;
    var text = troopPillLabel(troops, maxTroops);
    ctx.font = 'bold ' + fs + 'px "Aptos", "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = Math.max(1, fs * 0.25);
    var tw = ctx.measureText(text).width;
    var w = tw + 6;
    var h = Math.max(10, fs + 3);
    var x0 = cx - w / 2;
    var y0 = cy - h / 2;
    fillRoundRect(ctx, x0, y0, w, h, 4, "rgba(7, 12, 18, " + dyn.pillBgAlpha + ")", "rgba(" + rgb.cur + ", " + dyn.pillBdAlpha + ")");
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    drawTroopParts(ctx, cx - tw / 2, cy, troops, maxTroops, rgb);
  }

  // Combined money + max troops pill on a single line.
  function drawMoneyTroopPill(ctx, cx, cy, moneyText, maxTroops, dyn, troops, rgb, ms) {
    var fs = dyn.moneyFontSize;
    var maxLabel = troopPillLabel(troops, maxTroops);
    var combined = moneyText + "  " + maxLabel;

    ctx.font = 'bold ' + fs + 'px "Aptos", "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = Math.max(1, fs * 0.25);

    var tw = ctx.measureText(combined).width;
    var w = tw + 8;
    var h = Math.max(10, fs + 3);
    var x0 = cx - w / 2;
    var y0 = cy - h / 2;

    fillRoundRect(ctx, x0, y0, w, h, 4, "rgba(7, 12, 18, " + dyn.pillBgAlpha + ")", "rgba(" + ms.rgb + ", " + dyn.pillBdAlpha + ")");

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    // Draw money part (colour by what it buys)
    var moneyW = ctx.measureText(moneyText).width;
    var gap = ctx.measureText("  ").width;
    var startX = cx - tw / 2;

    ctx.textAlign = "left";
    drawMoneyText(ctx, moneyText, startX, cy + 0.5, ms);

    // Draw current/max troops part (each colored against yours)
    drawTroopParts(ctx, startX + moneyW + gap, cy, troops, maxTroops, rgb);
  }

  // Small rounded-rect helper (background + optional border).
  function fillRoundRect(ctx, x, y, w, h, r, bg, border) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = bg;
    ctx.fill();
    if (border) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = border;
      ctx.stroke();
    }
  }

  // Troop ratio bar — 1:1 with Tactical Assistant name-overlay (lines 7942-7969).
  // home troops = green (fixed, NOT faction color), attacking = orange, total bar
  // length = total/max. The "/max" label is drawn as its own pill on the line
  // above (drawMoneyTroopPill or drawMaxTroopPill), never on the bar itself.
  function drawTroopBar(ctx, cx, barTop, relation, troops, attacking, maxTroops, dyn) {
    var barW = dyn.troopBarW;
    var barH = dyn.troopBarH;
    var barX = cx - barW / 2;
    var max = Math.max(1, maxTroops);
    var total = troops + attacking;
    var totalRatio = Math.min(total / max, 1);
    var mainRatio = attacking === 0 ? 1 : total > 0 ? troops / total : 0;
    var bufferRatio = attacking === 0 ? 0 : total > 0 ? attacking / total : 0;
    var mainW = mainRatio * totalRatio * barW;
    var bufferW = bufferRatio * totalRatio * barW;

    ctx.fillStyle = "rgba(34, 34, 34, " + dyn.barBgAlpha + ")";
    ctx.fillRect(barX, barTop, barW, barH);
    ctx.fillStyle = "rgba(0, 210, 82, 0.85)";
    ctx.fillRect(barX, barTop, mainW, barH);
    if (bufferW > 0) {
      ctx.fillStyle = "rgba(255, 166, 0, 0.7)";
      ctx.fillRect(barX + mainW, barTop, bufferW, barH);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(68, 68, 68, 0.8)";
    ctx.strokeRect(barX + 0.5, barTop + 0.5, barW - 1, barH - 1);
  }

  function drawPlayerOverlay(ctx, game, transform) {
    const me = game.myPlayer ? game.myPlayer() : null;
    let myTroops = 1;
    try {
      myTroops = Math.max(1, Number(me && me.troops ? me.troops() : 1) || 1);
    } catch (_error) {
      myTroops = 1;
    }
    let myMax = 1;
    try {
      myMax = Math.max(1, Number(me ? advMaxTroops(game, me) : 1) || 1);
    } catch (_error) {
      myMax = 1;
    }

    for (let i = 0; i < _playerOverlayScan.length; i += 1) {
      const entry = _playerOverlayScan[i];
      const player = entry.player;
      let loc = null;
      try {
        loc = player.nameLocation ? player.nameLocation() : null;
      } catch (_error) {
        loc = null;
      }
      if (!loc) {
        continue;
      }
      var p = mapWorldToScreen(transform, loc.x, loc.y);
      if (!p || !mapPointOnScreen(p.x, p.y, 30)) {
        continue;
      }
      var dyn = _getDynamicSizes(loc, transform);
      if (!dyn.visible) {
        continue;
      }
      var color = mapFactionColor(entry.relation);

      if (!entry.skipOverlay) {
        var liveTroops = entry.troops;
        if (mapTroopCountsEnabled) {
          try {
            liveTroops = Number(player.troops ? player.troops() : entry.troops) || entry.troops;
          } catch (_error) {
            liveTroops = entry.troops;
          }
        }

        var troopRgb = {
          cur: troopCompareColor(entry.relation, liveTroops, myTroops),
          max: troopCompareColor(entry.relation, entry.maxTroops, myMax),
        };
        if (mapMoneyEnabled && mapTroopCountsEnabled) {
          // Combined: money + current/max on one line, troop bar below.
          drawMoneyTroopPill(ctx, p.x, p.y - dyn.moneyOffsetY, formatMapGold(entry.gold), entry.maxTroops, dyn, liveTroops, troopRgb, moneyStyle(game, player, entry.gold));
          drawTroopBar(ctx, p.x, p.y - dyn.troopOffsetY, entry.relation, liveTroops, entry.inCombat, entry.maxTroops, dyn);
        } else if (mapMoneyEnabled) {
          drawMoneyPill(ctx, p.x, p.y - dyn.moneyOffsetY, formatMapGold(entry.gold), dyn, moneyStyle(game, player, entry.gold));
        } else if (mapTroopCountsEnabled) {
          // Money off: current/max still gets its own line above the bar.
          drawMaxTroopPill(ctx, p.x, p.y - dyn.moneyOffsetY, entry.maxTroops, dyn, liveTroops, troopRgb);
          drawTroopBar(ctx, p.x, p.y - dyn.troopOffsetY, entry.relation, liveTroops, entry.inCombat, entry.maxTroops, dyn);
        }
      }

      if (threatIndicatorsEnabled && entry.isEnemy && !entry.skipOverlay) {
        drawThreatMarks(ctx, p.x, p.y + 10, entry, myTroops);
      }
    }
  }

  function drawThreatMarks(ctx, x, baseY, entry, myTroops) {
    const threat = entry.threat;
    const troops = entry.troops;
    if (threat && (threat.nukeCapable || threat.buildingNuke)) {
      drawMapHaloText(ctx, x - 30, baseY, "☢", "rgba(248, 113, 113, 0.95)");
    }
    // Ratios are scale-invariant → compare raw values directly.
    let dot = null;
    if (troops >= 1.35 * myTroops) {
      dot = "rgba(248, 113, 113, 0.95)"; // stronger than you
    } else if (entry.maxTroops > 0 && troops <= 0.1 * entry.maxTroops) {
      dot = "rgba(251, 191, 36, 0.95)"; // weak
    }
    if (dot) {
      ctx.beginPath();
      ctx.arc(x + 30, baseY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.stroke();
    }
  }

  registerMapOverlayLayer({
    id: "player-overlay",
    scanIntervalMs: 500,
    isEnabled: playerOverlayEnabled,
    scan: function (game) {
      scanPlayerOverlay(game);
    },
    draw: function (ctx, game, transform) {
      drawPlayerOverlay(ctx, game, transform);
    },
  });

  function setPlayerMapOverlaysEnabled(enabled) {
    playerMapOverlaysEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setMapTroopCountsEnabled(enabled) {
    mapTroopCountsEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setThreatIndicatorsEnabled(enabled) {
    threatIndicatorsEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }

  function setMapMoneyEnabled(enabled) {
    mapMoneyEnabled = Boolean(enabled);
    if (!playerOverlayEnabled()) {
      _playerOverlayScan = [];
    }
    requestMapOverlayLoop();
  }
