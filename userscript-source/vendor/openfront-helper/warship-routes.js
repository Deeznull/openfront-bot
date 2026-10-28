// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/warship-routes.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Warship route overlay: destination markers + travel routes for warships,
// colored by relation (self/team/ally/enemy). Mirrors boat-prediction.js but
// simpler — always-on when enabled, no hover/focus/panel. Reuses boat-prediction
// helpers from the shared in-game scope (toScreenPoint, getBoatRouteScreenPoints,
// getBoatPredictionRelation, getOpenFrontGameContext, …). Destination = the
// warship's patrolTile (its move order), fallback = the end of its motion plan.

  const WARSHIP_ROUTES_CONTAINER_ID = "openfront-helper-warship-routes-layer";
  const WARSHIP_ROUTES_STYLE_ID = "openfront-helper-warship-routes-style";
  const WARSHIP_ROUTES_SCAN_MS = 600;
  // A warship parked AT its patrolTile has start≈end → a degenerate near-zero route
  // + a diamond sitting on the ship. Only draw when it is actually travelling toward
  // an order (manhattan ship→dest above this), so the overlay reads as "where is it
  // headed" rather than a marker on every idle ship.
  const WARSHIP_ROUTE_MIN_DIST = 6;
  let warshipRoutesEnabled = false;
  // Per-faction sub-toggles (default on) — which relations' warship routes draw.
  let warshipShowOwn = true;
  let warshipShowTeam = true;
  let warshipShowAlly = true;
  let warshipShowEnemy = true;
  function warshipFactionEnabled(relation) {
    switch (relation) {
      case "self":
        return warshipShowOwn;
      case "team":
        return warshipShowTeam;
      case "ally":
        return warshipShowAlly;
      default:
        return warshipShowEnemy;
    }
  }
  let warshipRoutesAnimationFrame = null;
  let lastWarshipRouteScanAt = 0;
  let warshipRouteScan = []; // [{ id, unit, color, motionPlanUnitId, destWorldX, destWorldY }]
  const warshipRouteDomCache = new Map(); // id -> { routeLine, marker, routePoints, markerX, markerY, signature }

  function warshipRouteColor(relation) {
    switch (relation) {
      case "self":
        return "rgba(96, 165, 250, 0.95)"; // blue
      case "team":
        return "rgba(45, 212, 191, 0.95)"; // teal
      case "ally":
        return "rgba(74, 222, 128, 0.95)"; // green
      default:
        return "rgba(248, 113, 113, 0.95)"; // enemy red
    }
  }

  function ensureWarshipRouteStyles() {
    if (document.getElementById(WARSHIP_ROUTES_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = WARSHIP_ROUTES_STYLE_ID;
    style.textContent = `
      #${WARSHIP_ROUTES_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 7000;
        pointer-events: none;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-route-svg {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
        pointer-events: none;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-route-line {
        fill: none;
        stroke-width: 2;
        stroke-dasharray: 1 4;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.75;
      }
      #${WARSHIP_ROUTES_CONTAINER_ID} .openfront-helper-warship-dest {
        position: fixed;
        left: 0;
        top: 0;
        width: 14px;
        height: 14px;
        border: 2px solid var(--ws-color);
        border-radius: 3px;
        background: transparent;
        box-shadow: 0 0 5px var(--ws-color);
        transform: translate3d(var(--ws-tx, 0px), var(--ws-ty, 0px), 0) translate(-50%, -50%) rotate(45deg);
        will-change: transform;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureWarshipRouteContainer() {
    ensureWarshipRouteStyles();
    let container = document.getElementById(WARSHIP_ROUTES_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = WARSHIP_ROUTES_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureWarshipRouteSvg(container) {
    let svg = container.querySelector(".openfront-helper-warship-route-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-warship-route-svg");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function collectWarshipRoutes(game) {
    const out = [];
    for (const unit of game.units("Warship")) {
      if (!unit?.isActive?.()) continue;
      const relation = getBoatPredictionRelation(game, unit);
      if (!relation) continue;
      if (!warshipFactionEnabled(relation)) continue; // per-faction sub-toggle

      // Destination = the warship's move order (patrolTile); fall back to the end
      // of its motion plan path if no patrolTile is set.
      let destTile = null;
      try {
        const pt = unit.warshipState?.()?.patrolTile;
        if (pt !== undefined && pt !== null) destTile = asFiniteTileRef(pt);
      } catch (_e) {
        /* ignore */
      }
      const motionPlanUnitId = Number(unit.id?.());
      if (destTile === null && Number.isFinite(motionPlanUnitId)) {
        try {
          const plan = game.motionPlans?.()?.get(motionPlanUnitId);
          if (plan?.path?.length) {
            destTile = asFiniteTileRef(plan.path[plan.path.length - 1]);
          }
        } catch (_e) {
          /* ignore */
        }
      }
      if (destTile === null) continue; // no known destination → nothing to draw

      let destWorldX = null;
      let destWorldY = null;
      try {
        destWorldX = game.x(destTile);
        destWorldY = game.y(destTile);
      } catch (_e) {
        continue;
      }

      // Skip warships effectively parked at their destination (idle-noise filter).
      try {
        const shipTile = unit.tile?.();
        if (shipTile !== undefined && shipTile !== null) {
          const d =
            Math.abs(game.x(shipTile) - destWorldX) +
            Math.abs(game.y(shipTile) - destWorldY);
          if (d < WARSHIP_ROUTE_MIN_DIST) continue;
        }
      } catch (_e) {
        /* ignore — draw it anyway if we can't measure */
      }

      out.push({
        id: String(unit.id?.() ?? `dest:${destTile}`),
        unit,
        color: warshipRouteColor(relation),
        motionPlanUnitId: Number.isFinite(motionPlanUnitId) ? motionPlanUnitId : null,
        destWorldX,
        destWorldY,
      });
    }
    return out;
  }

  function getWarshipRouteEntry(container, svg, item) {
    let entry = warshipRouteDomCache.get(item.id);
    if (!entry) {
      const routeLine = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      routeLine.classList.add("openfront-helper-warship-route-line");
      routeLine.style.display = "none";
      svg.appendChild(routeLine);

      const marker = document.createElement("div");
      marker.className = "openfront-helper-warship-dest";
      marker.hidden = true;
      container.appendChild(marker);

      entry = {
        routeLine,
        marker,
        signature: "",
        routePoints: "",
        markerX: "",
        markerY: "",
      };
      warshipRouteDomCache.set(item.id, entry);
    }
    if (entry.signature !== item.color) {
      entry.routeLine.style.stroke = item.color;
      entry.marker.style.setProperty("--ws-color", item.color);
      entry.signature = item.color;
    }
    return entry;
  }

  function cleanupWarshipRouteDom(activeIds) {
    for (const [id, entry] of warshipRouteDomCache) {
      if (!activeIds.has(id)) {
        entry.routeLine.remove();
        entry.marker.remove();
        warshipRouteDomCache.delete(id);
      }
    }
  }

  function syncWarshipRoutes() {
    if (!warshipRoutesEnabled) {
      teardownWarshipRoutes();
      return;
    }
    const container = ensureWarshipRouteContainer();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      container.replaceChildren();
      warshipRouteDomCache.clear();
      warshipRouteScan = [];
      lastWarshipRouteScanAt = 0;
      warshipRoutesAnimationFrame = requestAnimationFrame(syncWarshipRoutes);
      return;
    }

    const svg = ensureWarshipRouteSvg(container);

    const now = Date.now();
    if (!lastWarshipRouteScanAt || now - lastWarshipRouteScanAt >= WARSHIP_ROUTES_SCAN_MS) {
      warshipRouteScan = collectWarshipRoutes(context.game);
      const ids = new Set();
      for (const item of warshipRouteScan) ids.add(item.id);
      cleanupWarshipRouteDom(ids);
      lastWarshipRouteScanAt = now;
    }

    resetScreenPointPool();

    for (let i = 0; i < warshipRouteScan.length; i += 1) {
      const item = warshipRouteScan[i];

      const destScreen = toScreenPointFromWorld(
        context.transform,
        item.destWorldX,
        item.destWorldY,
      );
      // Cull only when BOTH ends are off-screen-ish; keep partly-visible routes.
      const destNear = isNearViewport(destScreen, 240);
      const shipScreenPooled = toScreenPoint(
        context.game,
        context.transform,
        asFiniteTileRef(item.unit?.tile?.()),
      );
      const hasShip = shipScreenPooled != null;
      const shipX = hasShip ? shipScreenPooled.x : 0;
      const shipY = hasShip ? shipScreenPooled.y : 0;
      const shipNear = hasShip && isNearViewport({ x: shipX, y: shipY }, 240);

      const entry = getWarshipRouteEntry(container, svg, item);

      if (!destNear && !shipNear) {
        entry.routeLine.style.display = "none";
        if (!entry.marker.hidden) entry.marker.hidden = true;
        continue;
      }

      // Route polyline: current ship pos → motion-plan path → destination. With no
      // motion plan, getBoatRouteScreenPoints returns just [start, end] (straight).
      const destX = destScreen ? destScreen.x : 0;
      const destY = destScreen ? destScreen.y : 0;
      const points = getBoatRouteScreenPoints(
        context.game,
        context.transform,
        item.unit,
        item.motionPlanUnitId,
        hasShip ? { x: shipX, y: shipY } : null,
        destScreen ? { x: destX, y: destY } : null,
      );
      if (points.length >= 2) {
        let attr = "";
        for (let j = 0; j < points.length; j += 1) {
          attr += j === 0 ? `${points[j].x},${points[j].y}` : ` ${points[j].x},${points[j].y}`;
        }
        if (entry.routePoints !== attr) {
          entry.routeLine.setAttribute("points", attr);
          entry.routePoints = attr;
        }
        entry.routeLine.style.display = "";
      } else {
        entry.routeLine.style.display = "none";
      }

      // Destination marker.
      if (destScreen && destNear) {
        const tx = `${destX}px`;
        const ty = `${destY}px`;
        if (entry.markerX !== tx) {
          entry.marker.style.setProperty("--ws-tx", tx);
          entry.markerX = tx;
        }
        if (entry.markerY !== ty) {
          entry.marker.style.setProperty("--ws-ty", ty);
          entry.markerY = ty;
        }
        if (entry.marker.hidden) entry.marker.hidden = false;
      } else if (!entry.marker.hidden) {
        entry.marker.hidden = true;
      }
    }

    warshipRoutesAnimationFrame = requestAnimationFrame(syncWarshipRoutes);
  }

  function teardownWarshipRoutes() {
    if (warshipRoutesAnimationFrame !== null) {
      cancelAnimationFrame(warshipRoutesAnimationFrame);
    }
    warshipRoutesAnimationFrame = null;
    lastWarshipRouteScanAt = 0;
    warshipRouteScan = [];
    warshipRouteDomCache.clear();
    document.getElementById(WARSHIP_ROUTES_CONTAINER_ID)?.remove();
  }

  function setWarshipRoutesEnabled(enabled, factions) {
    warshipRoutesEnabled = Boolean(enabled);
    if (factions && typeof factions === "object") {
      if (factions.own !== undefined) warshipShowOwn = Boolean(factions.own);
      if (factions.team !== undefined) warshipShowTeam = Boolean(factions.team);
      if (factions.ally !== undefined) warshipShowAlly = Boolean(factions.ally);
      if (factions.enemy !== undefined) warshipShowEnemy = Boolean(factions.enemy);
    }
    // Full teardown so any now-hidden faction's DOM is removed, then rebuild.
    teardownWarshipRoutes();
    if (warshipRoutesEnabled) {
      syncWarshipRoutes();
    }
  }
