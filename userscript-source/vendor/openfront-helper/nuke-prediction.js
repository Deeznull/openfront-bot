// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/nuke-prediction.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Enemy nuke prediction: landing markers and blast radius overlay.

  const NUKE_UNIT_TYPES = ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"];

  // When several nukes of different relations target the same tile, the highest
  // rank decides the marker color: an incoming enemy strike (defensive warning)
  // outranks my own salvo, which outranks an ally's. In practice relations rarely
  // mix on a single tile, so for my own batch the marker is cyan with my count.
  const NUKE_RELATION_RANK = { ally: 1, self: 2, enemy: 3 };

  // Atom/Hydrogen follow a ground-launched parabola we can time for a "time to impact"
  // readout. MIRV Warheads are EXCLUDED: they spawn mid-air at the MIRV split and fly flat
  // (distanceBasedHeight:false) at a different speed, so the silo→target atom parabola would
  // give a garbage time — we keep their count marker but show no ETA.
  const NUKE_ETA_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb"]);

  function ensureNukeLandingStyles() {
    if (document.getElementById(NUKE_LANDING_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = NUKE_LANDING_STYLE_ID;
    style.textContent = `
      #${NUKE_LANDING_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone {
        position: fixed;
        left: 0;
        top: 0;
        width: var(--nuke-diameter);
        height: var(--nuke-diameter);
        border: 2px dashed var(--nuke-color, rgba(248, 113, 113, 0.92));
        border-radius: 50%;
        background: var(--nuke-bg, rgba(127, 29, 29, 0.18));
        box-shadow:
          0 0 18px var(--nuke-glow, rgba(248, 113, 113, 0.36)),
          inset 0 0 24px var(--nuke-inner-glow, rgba(248, 113, 113, 0.18));
        transform: translate3d(var(--nuke-tx, 0px), var(--nuke-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::before,
      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        background: var(--nuke-cross-color, rgba(254, 202, 202, 0.94));
        box-shadow: 0 0 10px var(--nuke-cross-glow, rgba(248, 113, 113, 0.6));
        transform: translate(-50%, -50%);
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::before {
        width: 28px;
        height: 2px;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-zone::after {
        width: 2px;
        height: 28px;
      }

      #${NUKE_LANDING_CONTAINER_ID} .openfront-helper-nuke-label {
        position: fixed;
        left: 0;
        top: 0;
        padding: 4px 8px;
        border: 1px solid var(--nuke-label-border, rgba(248, 113, 113, 0.52));
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--nuke-label-color, #fecaca);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate3d(var(--nuke-tx, 0px), var(--nuke-label-ty, 0px), 0) translate(-50%, -100%);
        will-change: transform;
        white-space: nowrap;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureNukeLandingContainer() {
    ensureNukeLandingStyles();

    let container = document.getElementById(NUKE_LANDING_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = NUKE_LANDING_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function getNukePredictionRelation(game, unit) {
    const owner = unit?.owner?.();
    const relation = getPlayerRelationToMyPlayer(game, owner);
    return relation === "enemy" || relation === "ally" || relation === "self"
      ? relation
      : null;
  }

  function getNukePredictionColors(relation) {
    if (relation === "ally") {
      return {
        color: "rgba(74, 222, 128, 0.92)",
        bg: "rgba(20, 83, 45, 0.18)",
        glow: "rgba(74, 222, 128, 0.36)",
        innerGlow: "rgba(74, 222, 128, 0.18)",
        crossColor: "rgba(187, 247, 208, 0.94)",
        crossGlow: "rgba(74, 222, 128, 0.6)",
        labelBorder: "rgba(74, 222, 128, 0.52)",
        labelColor: "#bbf7d0",
      };
    }

    if (relation === "self") {
      // Cyan/sky — distinct from enemy (red) and ally (green) so my own
      // outgoing salvo is instantly recognizable as mine.
      return {
        color: "rgba(56, 189, 248, 0.92)",
        bg: "rgba(8, 47, 73, 0.20)",
        glow: "rgba(56, 189, 248, 0.38)",
        innerGlow: "rgba(56, 189, 248, 0.18)",
        crossColor: "rgba(186, 230, 253, 0.96)",
        crossGlow: "rgba(56, 189, 248, 0.65)",
        labelBorder: "rgba(56, 189, 248, 0.55)",
        labelColor: "#bae6fd",
      };
    }

    return {
      color: "rgba(248, 113, 113, 0.92)",
      bg: "rgba(127, 29, 29, 0.18)",
      glow: "rgba(248, 113, 113, 0.36)",
      innerGlow: "rgba(248, 113, 113, 0.18)",
      crossColor: "rgba(254, 202, 202, 0.94)",
      crossGlow: "rgba(248, 113, 113, 0.6)",
      labelBorder: "rgba(248, 113, 113, 0.52)",
      labelColor: "#fecaca",
    };
  }

  function getNukeLandingRadius(game, unit) {
    try {
      const magnitude = game?.config?.().nukeMagnitudes?.(unit.type());
      const radius = Number(magnitude?.outer ?? magnitude?.inner);
      if (Number.isFinite(radius) && radius > 0) {
        return radius;
      }
    } catch (_error) {
      // Fall back to the same radii used by OpenFront's nuke FX layer.
    }

    return unit?.type?.() === "Hydrogen Bomb" ? 160 : 70;
  }

  function getNukeLandingScreenRadius(transform, screenPos, worldRadius) {
    const scale = Number(transform?.scale);
    if (Number.isFinite(scale) && scale > 0) {
      return worldRadius * scale;
    }

    try {
      const reference = transform.worldToScreenCoordinates({
        x: screenPos.worldX + worldRadius,
        y: screenPos.worldY,
      });
      const dx = reference.x - screenPos.x;
      const dy = reference.y - screenPos.y;
      return Math.hypot(dx, dy);
    } catch (_error) {
      return worldRadius;
    }
  }

  // DOM-element cache + scan cache. The active in-flight nuke list rarely
  // changes; the screen position changes every pan frame. Splitting these
  // updates eliminates the per-frame querySelector storm.
  const nukeLandingEntries = new Map();
  let nukeScanCache = []; // [{ unitId, targetTile, worldRadius, relation, count, eta }]
  let lastNukeScanAt = 0;
  const NUKE_SCAN_MS = 250;
  // Pre-allocated reusable objects. Eliminates per-landing per-frame allocs.
  const _nukeWorldQueryArg = { x: 0, y: 0 };
  const _nukeRadiusReusePos = { x: 0, y: 0, worldX: 0, worldY: 0 };
  // id → { firstTick, remainTicks } anchored once at first sight. The nuke advances exactly
  // one trajectory point per tick, so the ETA = remainTicks − (now − firstTick) counts down
  // 1:1 without recomputing the curve each frame. Pruned by id every scan (own map, separate
  // from the tile-keyed nukeLandingEntries).
  const nukeFlightById = new Map();

  // Remaining flight ticks from a point on the arc to the target, via the SAME parabola the
  // game uses (UniversalPathFinding lives in the auto-bot bundle; guarded in case it is not
  // loaded). Flight time is flip-INDEPENDENT — the arc LENGTH is identical whether it bows up
  // or down — so directionUp:true is valid no matter the firer's flip toggle.
  //
  // NOT path.length! A nuke moves `speed` of ARC distance per tick (NukeExecution →
  // curve.increment(speed)) and detonates when the distance flown exceeds the arc length, so
  // the true count is floor(arcLength/speed)+1. The cached path points are spaced slightly
  // MORE than `speed` apart (Bézier t-sampling overshoots the spacing), so counting points
  // under-counts ticks — and the gap grows with range (far shots read ~1–2 s fast). Summing
  // the real segment lengths from the tile coords matches the game to within ~0.2 s at any
  // distance.
  function computeNukeRemainingTicks(game, fromTile, toTile) {
    try {
      if (
        typeof UniversalPathFinding === "undefined" ||
        !UniversalPathFinding.Parabola ||
        fromTile === undefined ||
        fromTile === null ||
        toTile === undefined ||
        toTile === null
      ) {
        return null;
      }
      const speed = game.config?.().defaultNukeSpeed?.() ?? 8;
      const pf = UniversalPathFinding.Parabola(game, {
        increment: speed,
        distanceBasedHeight: true,
        directionUp: true,
      });
      const path = pf.findPath(fromTile, toTile);
      if (!Array.isArray(path) || path.length === 0) {
        return null;
      }
      if (path.length === 1) {
        return 1; // already at target
      }
      let arc = 0;
      for (let i = 1; i < path.length; i++) {
        const ax = game.x(path[i]);
        const ay = game.y(path[i]);
        const bx = game.x(path[i - 1]);
        const by = game.y(path[i - 1]);
        arc += Math.hypot(ax - bx, ay - by);
      }
      return Math.floor(arc / (speed > 0 ? speed : 8)) + 1;
    } catch (_error) {
      return null;
    }
  }

  function collectNukeScan(game) {
    const groupedByTile = new Map();
    const seenIds = new Set();
    const nowTicks = typeof game.ticks === "function" ? game.ticks() : 0;
    for (const unit of game.units(...NUKE_UNIT_TYPES)) {
      if (!unit?.isActive?.()) {
        continue;
      }
      const relation = getNukePredictionRelation(game, unit);
      if (!relation) {
        continue;
      }
      const targetTile = unit.targetTile?.();
      if (targetTile === undefined) {
        continue;
      }

      // Per-nuke ETA (seconds), atom/hydrogen only. Anchor once at first sight, then count
      // down linearly — the nuke steps one trajectory point per tick. MIRV warheads get no
      // ETA (their mid-air, flat-arc flight isn't this parabola).
      let etaSec = null;
      const unitType = unit.type?.();
      const id = unit.id?.();
      if (NUKE_ETA_TYPES.has(unitType) && id !== undefined) {
        seenIds.add(id);
        let flight = nukeFlightById.get(id);
        if (flight === undefined) {
          const remainTicks = computeNukeRemainingTicks(
            game,
            unit.tile?.(),
            targetTile,
          );
          if (remainTicks !== null) {
            flight = { firstTick: nowTicks, remainTicks };
            nukeFlightById.set(id, flight);
          }
        }
        if (flight !== undefined) {
          const etaTicks = flight.remainTicks - (nowTicks - flight.firstTick);
          etaSec = Math.round(Math.max(0, etaTicks / 10) * 10) / 10; // 0.1 s steps
        }
      }

      const landingId = `tile-${targetTile}`;
      const worldRadius = getNukeLandingRadius(game, unit);
      const existing = groupedByTile.get(landingId);
      if (existing) {
        existing.count += 1;
        if (worldRadius > existing.worldRadius) {
          existing.worldRadius = worldRadius;
        }
        if (
          (NUKE_RELATION_RANK[relation] ?? 0) >
          (NUKE_RELATION_RANK[existing.relation] ?? 0)
        ) {
          existing.relation = relation;
        }
        // Group ETA = the SOONEST incoming impact on this tile.
        if (etaSec !== null && (existing.eta === null || etaSec < existing.eta)) {
          existing.eta = etaSec;
        }
      } else {
        // World coords are fixed for an in-flight nuke; resolve once per scan
        // and reuse across pan frames instead of calling game.x/y per frame.
        groupedByTile.set(landingId, {
          landingId,
          targetTile,
          worldX: game.x(targetTile),
          worldY: game.y(targetTile),
          worldRadius,
          relation,
          count: 1,
          eta: etaSec,
        });
      }
    }
    // Prune flight anchors for nukes no longer in flight (landed/intercepted).
    if (nukeFlightById.size > 0) {
      for (const id of nukeFlightById.keys()) {
        if (!seenIds.has(id)) {
          nukeFlightById.delete(id);
        }
      }
    }
    return Array.from(groupedByTile.values());
  }

  function pruneNukeEntries() {
    const activeIds = new Set();
    for (const landing of nukeScanCache) {
      activeIds.add(landing.landingId);
    }
    for (const [landingId, entry] of nukeLandingEntries) {
      if (!activeIds.has(landingId)) {
        entry.zone.remove();
        entry.label.remove();
        nukeLandingEntries.delete(landingId);
      }
    }
  }

  function ensureNukeLandingEntry(container, landingId) {
    let entry = nukeLandingEntries.get(landingId);
    if (entry) {
      return entry;
    }
    const zone = document.createElement("div");
    zone.className = "openfront-helper-nuke-zone";
    zone.dataset.nukeId = landingId;
    container.appendChild(zone);
    const label = document.createElement("div");
    label.className = "openfront-helper-nuke-label";
    label.dataset.nukeId = landingId;
    container.appendChild(label);
    entry = {
      zone,
      label,
      hidden: false,
      tx: NaN,
      ty: NaN,
      labelTy: NaN,
      radius: NaN,
      relation: "",
      count: -1,
      eta: NaN,
    };
    nukeLandingEntries.set(landingId, entry);
    return entry;
  }

  function hideNukeEntry(entry) {
    if (!entry.hidden) {
      entry.zone.hidden = true;
      entry.label.hidden = true;
      entry.hidden = true;
    }
  }

  function applyNukeColors(zone, label, colors) {
    zone.style.setProperty("--nuke-color", colors.color);
    zone.style.setProperty("--nuke-bg", colors.bg);
    zone.style.setProperty("--nuke-glow", colors.glow);
    zone.style.setProperty("--nuke-inner-glow", colors.innerGlow);
    zone.style.setProperty("--nuke-cross-color", colors.crossColor);
    zone.style.setProperty("--nuke-cross-glow", colors.crossGlow);
    label.style.setProperty("--nuke-label-border", colors.labelBorder);
    label.style.setProperty("--nuke-label-color", colors.labelColor);
  }

  function syncNukePrediction() {
    if (!nukePredictionEnabled) {
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      nukeLandingEntries.clear();
      nukeFlightById.clear();
      nukeScanCache = [];
      lastNukeScanAt = 0;
      nukeLandingAnimationFrame = null;
      return;
    }

    const container = ensureNukeLandingContainer();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      if (nukeLandingEntries.size > 0) {
        for (const entry of nukeLandingEntries.values()) {
          entry.zone.remove();
          entry.label.remove();
        }
        nukeLandingEntries.clear();
      }
      nukeFlightById.clear();
      nukeScanCache = [];
      lastNukeScanAt = 0;
      nukeLandingAnimationFrame = requestAnimationFrame(syncNukePrediction);
      return;
    }

    const now = performance.now();
    if (now - lastNukeScanAt >= NUKE_SCAN_MS) {
      nukeScanCache = collectNukeScan(context.game);
      pruneNukeEntries();
      lastNukeScanAt = now;
    }

    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;

    for (let i = 0; i < nukeScanCache.length; i += 1) {
      const landing = nukeScanCache[i];
      // World coords were resolved during scan; only the screen mapping
      // changes during pan/zoom. Reuse a single input object for the
      // worldToScreenCoordinates call.
      _nukeWorldQueryArg.x = landing.worldX;
      _nukeWorldQueryArg.y = landing.worldY;

      let screenPos;
      try {
        screenPos = context.transform.worldToScreenCoordinates(_nukeWorldQueryArg);
      } catch (_error) {
        screenPos = null;
      }

      if (
        !Number.isFinite(screenPos?.x) ||
        !Number.isFinite(screenPos?.y) ||
        screenPos.x < -300 ||
        screenPos.y < -300 ||
        screenPos.x > innerWidth + 300 ||
        screenPos.y > innerHeight + 300
      ) {
        const existing = nukeLandingEntries.get(landing.landingId);
        if (existing) {
          hideNukeEntry(existing);
        }
        continue;
      }

      _nukeRadiusReusePos.x = screenPos.x;
      _nukeRadiusReusePos.y = screenPos.y;
      _nukeRadiusReusePos.worldX = landing.worldX;
      _nukeRadiusReusePos.worldY = landing.worldY;
      const radius = Math.max(
        12,
        getNukeLandingScreenRadius(
          context.transform,
          _nukeRadiusReusePos,
          landing.worldRadius,
        ),
      );

      const entry = ensureNukeLandingEntry(container, landing.landingId);
      if (entry.hidden) {
        entry.zone.hidden = false;
        entry.label.hidden = false;
        entry.hidden = false;
      }

      // Positioning is done via a single compositor-friendly transform
      // (translate3d) rather than left/top, so panning does not invalidate
      // paint for the glow/shadow layers of each landing zone.
      const tx = screenPos.x;
      const ty = screenPos.y;
      const labelTy = ty - radius - 10;
      if (entry.tx !== tx) {
        entry.zone.style.setProperty("--nuke-tx", `${tx}px`);
        entry.label.style.setProperty("--nuke-tx", `${tx}px`);
        entry.tx = tx;
      }
      if (entry.ty !== ty) {
        entry.zone.style.setProperty("--nuke-ty", `${ty}px`);
        entry.ty = ty;
      }
      if (entry.labelTy !== labelTy) {
        entry.label.style.setProperty("--nuke-label-ty", `${labelTy}px`);
        entry.labelTy = labelTy;
      }
      if (entry.radius !== radius) {
        entry.zone.style.setProperty("--nuke-diameter", `${radius * 2}px`);
        entry.radius = radius;
      }
      if (entry.relation !== landing.relation) {
        applyNukeColors(entry.zone, entry.label, getNukePredictionColors(landing.relation));
        entry.relation = landing.relation;
        entry.count = -1; // force the label prefix below to refresh on a relation flip
      }
      if (entry.count !== landing.count || entry.eta !== landing.eta) {
        const labelPrefix =
          landing.relation === "self"
            ? tr("My nuke")
            : landing.relation === "ally"
              ? tr("Ally nuke")
              : tr("Enemy nuke");
        const countPart = landing.count > 1 ? ` ${landing.count}x` : "";
        // "time to impact" of the soonest nuke on this tile (atom/hydrogen only).
        const etaPart =
          landing.eta != null ? ` · ${landing.eta.toFixed(1)}s` : "";
        entry.label.textContent = `${labelPrefix}${countPart}${etaPart}`;
        entry.count = landing.count;
        entry.eta = landing.eta;
      }
    }

    // Entries whose landing fell out of the scan cache are removed by
    // pruneNukeEntries on the next scan tick (no per-frame sweep here).

    nukeLandingAnimationFrame = requestAnimationFrame(syncNukePrediction);
  }

  function setNukePredictionEnabled(enabled) {
    nukePredictionEnabled = Boolean(enabled);
    if (!nukePredictionEnabled) {
      if (nukeLandingAnimationFrame !== null) {
        cancelAnimationFrame(nukeLandingAnimationFrame);
      }
      nukeLandingAnimationFrame = null;
      document.getElementById(NUKE_LANDING_CONTAINER_ID)?.remove();
      nukeLandingEntries.clear();
      nukeFlightById.clear();
      return;
    }

    if (nukeLandingAnimationFrame === null) {
      syncNukePrediction();
    }
  }
