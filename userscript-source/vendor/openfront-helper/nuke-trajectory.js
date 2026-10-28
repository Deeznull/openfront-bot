// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/nuke-trajectory.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Nuke trajectory line (feature #5): the predicted flight path from each in-flight
// nuke to its landing tile, as a dashed parabolic polyline colored by relation.
//
// Additive to nuke-prediction.js (which draws the landing circle + ETA label) — it
// does NOT touch that optimized file. Instead it is a layer on the shared
// map-overlay canvas, gated by the SAME toggle (showNukePrediction), and it reuses
// the exact UniversalPathFinding.Parabola the ETA readout uses, so the drawn line
// matches the game's real arc. Atom/Hydrogen follow the parabola; MIRV warheads
// (flat mid-air flight) fall back to a straight current→target line.

  const NUKE_TRAJ_UNIT_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];
  const NUKE_TRAJ_PARABOLA_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb"]);
  const NUKE_TRAJ_MAX_POINTS = 48;

  // Scan cache: [{ relation, worldPts: [{x,y}...] }]. World coords resolved in the
  // throttled scan; the per-frame draw only maps them to screen.
  let _nukeTrajScan = [];

  function nukeTrajColor(relation) {
    if (relation === "ally") {
      return "rgba(74, 222, 128, 0.85)";
    }
    if (relation === "self") {
      return "rgba(56, 189, 248, 0.85)"; // cyan — matches nuke-prediction's own-salvo color
    }
    return "rgba(248, 113, 113, 0.85)";
  }

  function computeNukeTrajectoryPath(game, fromTile, toTile, directionUp) {
    if (directionUp === undefined) directionUp = true;
    try {
      if (
        typeof UniversalPathFinding === "undefined" ||
        !UniversalPathFinding.Parabola
      ) {
        return null;
      }
      const speed =
        (game.config &&
          game.config().defaultNukeSpeed &&
          game.config().defaultNukeSpeed()) ||
        8;
      const pf = UniversalPathFinding.Parabola(game, {
        increment: speed,
        distanceBasedHeight: true,
        directionUp: directionUp,
      });
      const path = pf.findPath(fromTile, toTile);
      return Array.isArray(path) ? path : null;
    } catch (_error) {
      return null;
    }
  }

  // Cache the FULL flight path per nuke id, anchored the first time we see it.
  // The path is fixed (launch tile → target), so the drawn line never shortens
  // or jitters as the nuke advances — it stays put until the nuke lands. This
  // removes the "laggy" step-by-step redraw of a recomputed current→target line.
  const _nukeTrajById = new Map(); // id -> { relation, worldPts }

  // Try to read the player's current rocket-direction toggle from the
  // game's build-menu UI. Used for the player's OWN nukes only to match
  // the actual arc they chose (hotkey U flips this). AI nukes always use
  // true (up). Falls back to true on any failure.
  function readNukeDirection() {
    try {
      var bm = document.querySelector("build-menu");
      if (bm && bm.uiState && typeof bm.uiState.rocketDirectionUp === "boolean") {
        return bm.uiState.rocketDirectionUp;
      }
    } catch (_e) {}
    return true;
  }

  function collectNukeTrajectoryScan(game) {
    let units;
    try {
      units = game.units(...NUKE_TRAJ_UNIT_TYPES);
    } catch (_error) {
      _nukeTrajScan = [];
      return;
    }
    const out = [];
    const seen = new Set();
    for (const unit of units) {
      if (!unit || !unit.isActive || !unit.isActive()) {
        continue;
      }
      const relation = getNukePredictionRelation(game, unit);
      if (!relation) {
        continue;
      }
      const targetTile = unit.targetTile ? unit.targetTile() : undefined;
      const fromTile = unit.tile ? unit.tile() : undefined;
      if (
        targetTile === undefined ||
        targetTile === null ||
        fromTile === undefined ||
        fromTile === null
      ) {
        continue;
      }
      const id = unit.id ? unit.id() : `${fromTile}:${targetTile}`;
      seen.add(id);

      // Reuse the anchored path if we've already computed it for this nuke.
      let cached = _nukeTrajById.get(id);
      if (cached) {
        cached.relation = relation; // relation may flip (self→ally), keep fresh
        out.push(cached);
        continue;
      }

      const type = unit.type ? unit.type() : null;
      const worldPts = [];
      let path = null;
      if (NUKE_TRAJ_PARABOLA_TYPES.has(type)) {
        var dirUp = relation === "self" ? readNukeDirection() : true;
        path = computeNukeTrajectoryPath(game, fromTile, targetTile, dirUp);
      }
      if (path && path.length >= 2) {
        const step = Math.max(1, Math.ceil(path.length / NUKE_TRAJ_MAX_POINTS));
        for (let i = 0; i < path.length; i += step) {
          worldPts.push({ x: game.x(path[i]), y: game.y(path[i]) });
        }
        const last = path[path.length - 1];
        worldPts.push({ x: game.x(last), y: game.y(last) });
      } else {
        // MIRV / parabola unavailable → straight launch→target line.
        worldPts.push({ x: game.x(fromTile), y: game.y(fromTile) });
        worldPts.push({ x: game.x(targetTile), y: game.y(targetTile) });
      }
      cached = { relation, worldPts };
      _nukeTrajById.set(id, cached);
      out.push(cached);
    }
    // Prune paths of nukes that have landed / been intercepted.
    if (_nukeTrajById.size > 0) {
      for (const id of _nukeTrajById.keys()) {
        if (!seen.has(id)) _nukeTrajById.delete(id);
      }
    }
    _nukeTrajScan = out;
  }

  function drawNukeTrajectory(ctx, game, transform) {
    if (_nukeTrajScan.length === 0) {
      return;
    }
    const proj = typeof mapMakeProjector === "function" ? mapMakeProjector(transform) : null;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([5, 6]);
    const pt = { x: 0, y: 0 };
    for (let i = 0; i < _nukeTrajScan.length; i += 1) {
      const traj = _nukeTrajScan[i];
      const pts = traj.worldPts;
      if (!pts || pts.length < 2) {
        continue;
      }
      ctx.beginPath();
      let started = false;
      let anyVisible = false;
      for (let j = 0; j < pts.length; j += 1) {
        let sp;
        if (proj) {
          mapProject(proj, pts[j].x, pts[j].y, pt);
          sp = pt;
        } else {
          sp = mapWorldToScreen(transform, pts[j].x, pts[j].y);
          if (!sp) {
            started = false;
            continue;
          }
        }
        if (mapPointOnScreen(sp.x, sp.y, 200)) {
          anyVisible = true;
        }
        if (!started) {
          ctx.moveTo(sp.x, sp.y);
          started = true;
        } else {
          ctx.lineTo(sp.x, sp.y);
        }
      }
      if (anyVisible) {
        ctx.strokeStyle = nukeTrajColor(traj.relation);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  registerMapOverlayLayer({
    id: "nuke-trajectory",
    scanIntervalMs: 250,
    isEnabled: function () {
      // Sub-toggle of nuke prediction: only draws when both are on.
      return nukePredictionEnabled && nukeTrajectoryEnabled;
    },
    scan: function (game) {
      collectNukeTrajectoryScan(game);
    },
    draw: function (ctx, game, transform) {
      drawNukeTrajectory(ctx, game, transform);
    },
  });

  function setNukeTrajectoryEnabled(enabled) {
    nukeTrajectoryEnabled = Boolean(enabled);
    if (typeof requestMapOverlayLoop === "function") {
      requestMapOverlayLoop();
    }
  }
