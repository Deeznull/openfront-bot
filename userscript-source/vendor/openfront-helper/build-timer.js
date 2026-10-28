// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/build-timer.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Build timer overlay — shows construction countdown and missile cooldown timers
// above Missile Silos and SAM Launchers on the map. A layer on the shared
// map-overlay scheduler.
//
// Data source: game.units("Missile Silo", "SAM Launcher") + unit properties
// (isUnderConstruction, missileTimerQueue, level, tile, id). Construction
// progress is tracked by recording the tick when a unit first appears as
// under-construction, then counting down from the configured duration.
// Cooldown is read from missileTimerQueue (array of fire ticks).

  const BUILD_TIMER_TYPES = ["Missile Silo", "SAM Launcher"];
  const BUILD_TIMER_COOLDOWN_TICKS = 90; // default missile cooldown
  const BUILD_TIMER_DEFAULT_DURATION = {
    "Missile Silo": 100,   // 10s at 10 ticks/s
    "SAM Launcher": 300,   // 30s (SAM_CONSTRUCTION_TICKS)
  };

  // Map: unitId -> firstSeenTick (when we first saw it under construction).
  const _buildTimerConstructionSeen = new Map();
  // Scan cache: [{ id, type, worldX, worldY, label, ready }].
  let _buildTimerScan = [];

  function getConstructionDuration(game, type) {
    try {
      const info = game.config && game.config().unitInfo
        ? game.config().unitInfo(type)
        : null;
      if (info && Number.isFinite(info.constructionDuration) && info.constructionDuration > 0) {
        return info.constructionDuration;
      }
    } catch (_error) { /* ignore */ }
    return BUILD_TIMER_DEFAULT_DURATION[type] || 100;
  }

  function scanBuildTimers(game) {
    let units;
    try {
      units = game.units(...BUILD_TIMER_TYPES);
    } catch (_error) {
      _buildTimerScan = [];
      return;
    }
    const ticks = game.ticks ? game.ticks() : 0;
    const out = [];
    const seenIds = new Set();

    for (const unit of units) {
      if (!unit || !unit.isActive || !unit.isActive()) continue;
      const id = unit.id ? unit.id() : null;
      if (id == null) continue;
      seenIds.add(id);
      const type = unit.type ? unit.type() : null;
      const tile = unit.tile ? unit.tile() : null;
      if (tile == null) continue;

      let worldX = 0, worldY = 0;
      try {
        worldX = game.x(tile);
        worldY = game.y(tile);
      } catch (_error) { continue; }

      const underConstruction = Boolean(unit.isUnderConstruction && unit.isUnderConstruction());

      if (underConstruction) {
        // Track when we first saw this unit under construction.
        if (!_buildTimerConstructionSeen.has(id)) {
          _buildTimerConstructionSeen.set(id, ticks);
        }
        const firstSeen = _buildTimerConstructionSeen.get(id);
        const duration = getConstructionDuration(game, type);
        const remaining = Math.max(0, duration - (ticks - firstSeen));
        const sec = Math.round(remaining / 10);
        const label = sec > 0 ? `🏗 ${sec}s` : tr("Building");
        out.push({ id, type, worldX, worldY, label, state: "building" });
      } else {
        // Done building — remove from construction tracker.
        _buildTimerConstructionSeen.delete(id);

        // Check missile cooldown.
        let queue = [];
        try {
          queue = unit.missileTimerQueue ? unit.missileTimerQueue() : [];
        } catch (_error) { queue = []; }
        let level = 1;
        try {
          level = Number(unit.level ? unit.level() : 1) || 1;
        } catch (_error) { level = 1; }

        if (Array.isArray(queue) && queue.length >= level) {
          const lastFired = queue[0];
          const remaining = BUILD_TIMER_COOLDOWN_TICKS - (ticks - lastFired);
          if (remaining > 0) {
            const sec = Math.round(remaining / 10);
            out.push({ id, type, worldX, worldY, label: `⟳ ${sec}s`, state: "cooldown" });
          } else {
            out.push({ id, type, worldX, worldY, label: "✓", state: "ready" });
          }
        } else {
          out.push({ id, type, worldX, worldY, label: "✓", state: "ready" });
        }
      }
    }

    // Prune construction tracker for units no longer in the scan.
    for (const id of _buildTimerConstructionSeen.keys()) {
      if (!seenIds.has(id)) _buildTimerConstructionSeen.delete(id);
    }

    _buildTimerScan = out;
  }

  function drawBuildTimers(ctx, game, transform) {
    if (_buildTimerScan.length === 0) return;
    ctx.save();
    for (const entry of _buildTimerScan) {
      const p = mapWorldToScreen(transform, entry.worldX, entry.worldY);
      if (!p || !mapPointOnScreen(p.x, p.y, 30)) continue;

      const font = 'bold 11px "Aptos", monospace';
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(entry.label).width;
      const boxW = tw + 10;
      const boxH = 16;
      const bx = p.x - boxW / 2;
      const by = p.y - boxH - 6; // above the unit

      // Colors by state; the "ready" ✓ is further split by unit type so Silo and
      // SAM are distinguishable at a glance: Silo ready = green, SAM ready = cyan.
      let fg = "#9ccc65";
      let border = "rgba(156, 204, 101, 0.5)";
      if (entry.state === "building") {
        fg = "#60a5fa"; // blue
        border = "rgba(96, 165, 250, 0.5)";
      } else if (entry.state === "cooldown") {
        fg = "#ffd54f"; // amber
        border = "rgba(255, 213, 79, 0.5)";
      } else if (entry.type === "SAM Launcher") {
        fg = "#22d3ee"; // SAM ready = cyan
        border = "rgba(34, 211, 238, 0.5)";
      } // else Silo ready = green (default)
      ctx.fillStyle = "rgba(7, 12, 18, 0.82)";
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = border;
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
      ctx.fillStyle = fg;
      ctx.fillText(entry.label, p.x, by + boxH / 2 + 0.5);
    }
    ctx.restore();
  }

  registerMapOverlayLayer({
    id: "build-timers",
    scanIntervalMs: 250,
    isEnabled: function () { return buildTimerEnabled; },
    scan: function (game) { scanBuildTimers(game); },
    draw: function (ctx, game, transform) { drawBuildTimers(ctx, game, transform); },
  });

  function setBuildTimerEnabled(enabled) {
    buildTimerEnabled = Boolean(enabled);
    if (!buildTimerEnabled) {
      _buildTimerScan = [];
      _buildTimerConstructionSeen.clear();
    }
    requestMapOverlayLoop();
  }
