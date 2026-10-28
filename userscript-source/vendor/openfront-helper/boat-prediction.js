// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/boat-prediction.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Enemy boat prediction: landing markers for transport ships.

  const BOAT_UNIT_TYPES = ["Transport"];
  const BOAT_LANDING_HOVER_RADIUS_PX = 18;
  const BOAT_LANDING_HOVER_RADIUS_SQUARED =
    BOAT_LANDING_HOVER_RADIUS_PX * BOAT_LANDING_HOVER_RADIUS_PX;
  const BOAT_PREDICTION_SCAN_MS = 1000;
  let boatLandingMouseX = -9999;
  let boatLandingMouseY = -9999;
  let boatMouseListenerInstalled = false;
  let lastBoatPredictionScanAt = 0;
  let _boatFrameCounter = 0;
  let boatPredictionTransports = [];

  // Canvas-based rendering (Blon pattern). Set true to replace DOM/SVG completely.
  var _boatUseCanvas = true;
  const boatPredictionDomCache = new Map();
  let boatPredictionHoverElements = null;

  function ensureBoatLandingStyles() {
    if (document.getElementById(BOAT_LANDING_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = BOAT_LANDING_STYLE_ID;
    style.textContent = `
      #${BOAT_LANDING_CONTAINER_ID} {
        position: fixed;
        inset: 0;
        z-index: 8000;
        pointer-events: none;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker {
        position: fixed;
        left: 0;
        top: 0;
        width: 14px;
        height: 14px;
        border: 2px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 3px var(--boat-color);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::before,
      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        background: var(--boat-color);
        transform: translate(-50%, -50%);
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::before {
        width: 10px;
        height: 1.5px;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-marker::after {
        width: 1.5px;
        height: 10px;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-label {
        position: fixed;
        left: 0;
        top: 0;
        padding: 3px 7px;
        border: 1px solid var(--boat-color);
        border-radius: 8px;
        background: rgba(7, 12, 18, 0.86);
        color: var(--boat-color);
        font: 900 11px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.92);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-label-ty, 0px), 0) translate(-50%, -100%);
        will-change: transform;
        white-space: nowrap;
      }

      @keyframes openfront-helper-boat-highlight-pulse {
        0%, 100% { box-shadow: 0 0 6px var(--boat-color), 0 0 12px var(--boat-color); }
        50% { box-shadow: 0 0 10px var(--boat-color), 0 0 18px var(--boat-color); opacity: 0.78; }
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-highlight {
        position: fixed;
        left: 0;
        top: 0;
        width: 20px;
        height: 20px;
        border: 2px solid var(--boat-color);
        border-radius: 50%;
        background: var(--boat-bg);
        box-shadow: 0 0 4px var(--boat-color);
        transform: translate3d(var(--boat-tx, 0px), var(--boat-ty, 0px), 0) translate(-50%, -50%);
        will-change: transform;
        animation: openfront-helper-boat-highlight-pulse 1.1s ease-in-out infinite;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-highlight.is-strong {
        width: 34px;
        height: 34px;
        border-width: 3.5px;
        box-shadow: 0 0 10px var(--boat-color), 0 0 20px var(--boat-color);
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-hover-svg {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: visible;
        pointer-events: none;
      }

      #${BOAT_LANDING_CONTAINER_ID} .openfront-helper-boat-route-polyline {
        fill: none;
        stroke-width: 2;
        stroke-dasharray: 4 3;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.68;
      }

    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBoatLandingContainer() {
    ensureBoatLandingStyles();

    let container = document.getElementById(BOAT_LANDING_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = BOAT_LANDING_CONTAINER_ID;
      container.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function ensureBoatMouseListener() {
    if (boatMouseListenerInstalled) {
      return;
    }
    boatMouseListenerInstalled = true;
    document.addEventListener(
      "mousemove",
      (e) => {
        boatLandingMouseX = e.clientX;
        boatLandingMouseY = e.clientY;
      },
      { passive: true },
    );
  }

  function ensureBoatRouteSvg(container) {
    let svg = container.querySelector(".openfront-helper-boat-hover-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("openfront-helper-boat-hover-svg");
      svg.setAttribute("aria-hidden", "true");
      container.prepend(svg);
    }
    return svg;
  }

  function getBoatRouteScreenPoints(game, transform, unit, motionPlanUnitId, boatScreenPos, landingScreenPos) {
    const points = [];

    if (boatScreenPos) {
      points.push({ x: boatScreenPos.x, y: boatScreenPos.y });
    }

    try {
      if (Number.isFinite(motionPlanUnitId)) {
        const plan = game?.motionPlans?.()?.get(motionPlanUnitId);
        if (plan?.path && plan.path.length > 0) {
          const path = plan.path;
          const currentTick = Number(game?.ticks?.());
          const elapsed = Number.isFinite(currentTick) ? currentTick - plan.startTick : 0;
          const currentStep = Math.max(
            0,
            Math.min(
              Math.floor(elapsed / Math.max(1, plan.ticksPerStep)),
              path.length - 1,
            ),
          );
          const remainingLength = path.length - currentStep;
          const maxSamples = 40;
          const sampleStep = Math.max(1, Math.floor(remainingLength / maxSamples));

          for (let i = currentStep; i < path.length; i += sampleStep) {
            const pt = toScreenPoint(game, transform, path[i]);
            if (pt) {
              points.push({ x: pt.x, y: pt.y });
            }
          }
        }
      }
    } catch (_error) {
      // Fall back to direct line if route unavailable.
    }

    if (landingScreenPos) {
      points.push({ x: landingScreenPos.x, y: landingScreenPos.y });
    }

    return points;
  }

  function getBoatPredictionRelation(game, unit) {
    const owner = unit?.owner?.();
    try {
      const myPlayer = game?.myPlayer?.();
      if (!owner?.isPlayer?.() || !myPlayer?.isPlayer?.()) {
        return null;
      }
      if (Number(owner.smallID?.()) === Number(myPlayer.smallID?.())) {
        return "self";
      }
      // Distinguish teammates (same team) from manual alliances (possibly
      // cross-team). The shared getPlayerRelationToMyPlayer collapses both into
      // "ally"; boat prediction needs them apart so each gets its own colour and
      // its own always-route toggle.
      if (myPlayer.isOnSameTeam?.(owner)) {
        return "team";
      }
      if (myPlayer.isAlliedWith?.(owner)) {
        return "ally";
      }
      // Fallback for older builds missing the granular APIs: any friendly → ally.
      if (owner.isFriendly?.(myPlayer) || myPlayer.isFriendly?.(owner)) {
        return "ally";
      }
      return "enemy";
    } catch (_error) {
      return null;
    }
  }

  // Routes are hover-only by default. Each "always show …" sub-setting opts its
  // relation into a persistent route — but only while the prediction overlay is
  // on. The panel draws focused-boat routes independently of these flags.
  function shouldBoatRouteAlwaysShow(transport) {
    if (!boatPredictionEnabled) {
      return false;
    }
    switch (transport.relation) {
      case "self":
        return boatPredictionAlwaysOwnRoutes;
      case "team":
        return boatPredictionAlwaysTeamRoutes;
      case "ally":
        return boatPredictionAlwaysAllyRoutes;
      case "enemy":
        return boatPredictionAlwaysEnemyRoutes;
      default:
        return false;
    }
  }

  function getBoatPredictionColors(relation, targeting) {
    if (relation === "self") {
      return {
        color: "rgba(96, 165, 250, 0.95)",
        bg: "rgba(30, 58, 138, 0.22)",
      };
    }

    if (relation === "team") {
      return {
        color: "rgba(45, 212, 191, 0.95)",
        bg: "rgba(19, 78, 74, 0.22)",
      };
    }

    if (relation === "ally") {
      return {
        color: "rgba(74, 222, 128, 0.95)",
        bg: "rgba(20, 83, 45, 0.2)",
      };
    }

    return {
      color: targeting ? "rgba(248, 113, 113, 0.95)" : "rgba(250, 204, 21, 0.95)",
      bg: targeting ? "rgba(127, 29, 29, 0.22)" : "rgba(113, 90, 0, 0.18)",
    };
  }

  function isBoatOverlayActive() {
    // The shared scan/render loop runs for any consumer that needs it: the
    // prediction overlay, an open boat panel (focused routes), or the incoming
    // warning (which needs the periodic scan to spot new boats).
    return boatPredictionEnabled || boatPanelOpen || boatWarnIncoming;
  }

  // Remaining travel time for a transport, from the game's own motion plan (the
  // same data it uses to advance the ship). null once the plan is cleared, i.e.
  // the boat has essentially arrived.
  function computeBoatEtaMs(game, transport) {
    try {
      const id = transport?.motionPlanUnitId;
      if (!Number.isFinite(id)) {
        return null;
      }
      const plan = game?.motionPlans?.()?.get(id);
      if (!plan?.path || !plan.path.length) {
        return null;
      }
      const endTick = plan.startTick + plan.path.length * plan.ticksPerStep;
      const remainingTicks = endTick - Number(game?.ticks?.());
      const msPerTick = Number(game?.config?.()?.msPerTick?.()) || 100;
      return Math.max(0, remainingTicks * msPerTick);
    } catch (_error) {
      return null;
    }
  }

  function formatBoatEta(ms) {
    if (ms == null) {
      return tr("arriving");
    }
    const totalSec = Math.max(0, Math.round(ms / 1000));
    if (totalSec < 60) {
      return `${totalSec}s`;
    }
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}m ${seconds < 10 ? "0" : ""}${seconds}s`;
  }

  function isBoatTargetingMyPlayer(game, targetTile) {
    try {
      const myPlayer = game?.myPlayer?.();
      if (!myPlayer?.isPlayer?.()) {
        return false;
      }
      const ownerId = game.ownerID?.(targetTile);
      return Number(ownerId) === Number(myPlayer.smallID?.());
    } catch (_error) {
      return false;
    }
  }

  function asFiniteTileRef(value) {
    const tile = Number(value);
    return Number.isFinite(tile) ? tile : null;
  }

  function getBoatTargetTile(unit) {
    return asFiniteTileRef(unit?.targetTile?.());
  }

  function getBoatOwnerLabel(unit) {
    const owner = unit?.owner?.();
    if (!owner) {
      return "Unknown";
    }

    let name = "Unknown";
    try {
      name = typeof getPlayerDisplayName === "function"
        ? getPlayerDisplayName(owner)
        : String(owner.displayName?.() ?? owner.name?.() ?? "Unknown");
    } catch (_error) {
      name = "Unknown";
    }

    const compactName = String(name || "Unknown").trim();
    if (compactName.length <= 18) {
      return compactName;
    }
    return `${compactName.slice(0, 17)}...`;
  }

  // Reused screen-point objects. toScreenPoint is called once per visible
  // transport per frame; a fresh allocation each call piled up GC pressure
  // during panning. Three slots cover landing-pos + boat-pos + one-off uses
  // within a single frame; callers must not retain references across yields.
  const _screenPointPool = [
    { x: 0, y: 0, worldX: 0, worldY: 0 },
    { x: 0, y: 0, worldX: 0, worldY: 0 },
    { x: 0, y: 0, worldX: 0, worldY: 0 },
  ];
  let _screenPointPoolIndex = 0;
  const _toScreenPointQueryArg = { x: 0, y: 0 };

  function resetScreenPointPool() {
    _screenPointPoolIndex = 0;
  }

  function toScreenPoint(game, transform, tile) {
    if (tile == null) {
      return null;
    }
    try {
      const worldX = game.x(tile);
      const worldY = game.y(tile);
      return toScreenPointFromWorld(transform, worldX, worldY);
    } catch (_error) {
      return null;
    }
  }

  // Fast-path variant that skips the game.x/game.y proxy calls when callers
  // have pre-resolved world coords (boat scan, nuke scan).
  function toScreenPointFromWorld(transform, worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return null;
    }
    try {
      _toScreenPointQueryArg.x = worldX;
      _toScreenPointQueryArg.y = worldY;
      const point = transform.worldToScreenCoordinates(_toScreenPointQueryArg);
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        return null;
      }
      const slot = _screenPointPool[
        _screenPointPoolIndex % _screenPointPool.length
      ];
      _screenPointPoolIndex += 1;
      slot.x = point.x;
      slot.y = point.y;
      slot.worldX = worldX;
      slot.worldY = worldY;
      return slot;
    } catch (_error) {
      return null;
    }
  }

  function isNearViewport(point, padding = 220) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      return false;
    }
    return (
      point.x >= -padding &&
      point.y >= -padding &&
      point.x <= window.innerWidth + padding &&
      point.y <= window.innerHeight + padding
    );
  }

  function collectBoatPredictionTransports(game) {
    const transports = [];

    for (const unit of game.units(...BOAT_UNIT_TYPES)) {
      if (!unit?.isActive?.()) {
        continue;
      }

      const relation = getBoatPredictionRelation(game, unit);
      if (!relation) {
        continue;
      }

      try {
        if (unit.retreating?.()) {
          continue;
        }
      } catch (_error) {
        // ignore
      }

      const targetTile = getBoatTargetTile(unit);
      if (targetTile === null) {
        continue;
      }

      // Whether the boat is heading INTO my current territory. Resolved live
      // each scan (not cached per-unit): targetTile is fixed for the boat's
      // life, but its owner changes — e.g. an enemy boat aimed at neutral land
      // that I then capture should start counting as "incoming to my territory".
      const targetsMyTerritory = isBoatTargetingMyPlayer(game, targetTile);
      const targeting = relation === "enemy" && targetsMyTerritory;
      const { color, bg } = getBoatPredictionColors(relation, targeting);
      const labelPrefix =
        relation === "self"
          ? tr("Your landing")
          : relation === "team"
            ? tr("Team landing")
            : relation === "ally"
              ? tr("Ally landing")
              : targeting
                ? tr("Landing!")
                : tr("Landing");
      const ownerName = getBoatOwnerLabel(unit);
      const labelText = `${labelPrefix} · ${ownerName}`;
      const unitId = String(unit.id?.() ?? `target:${targetTile}`);
      const motionPlanUnitId = Number(unit.id?.());

      transports.push({
        domUnitId: unitId,
        motionPlanUnitId: Number.isFinite(motionPlanUnitId) ? motionPlanUnitId : null,
        unit,
        relation,
        targetTile,
        targetsMyTerritory,
        ownerName,
        // Target world coords are fixed per transport; cache once per scan.
        targetWorldX: game.x(targetTile),
        targetWorldY: game.y(targetTile),
        color,
        bg,
        labelText,
      });
    }

    return transports;
  }

  function clearBoatPredictionDomCache() {
    boatPredictionDomCache.clear();
    boatPredictionHoverElements = null;
  }

  function getBoatPredictionDomEntry(container, routeSvg, transport) {
    let entry = boatPredictionDomCache.get(transport.domUnitId);
    if (!entry) {
      // Marker starts hidden: it is gated per-frame on the prediction overlay
      // being on (the panel can run the loop with the overlay off).
      const marker = document.createElement("div");
      marker.className = "openfront-helper-boat-marker";
      marker.dataset.boatId = `${transport.domUnitId}-marker`;
      marker.hidden = true;
      container.appendChild(marker);

      // Each transport owns its route polyline so several routes can show at
      // once (own boats + always-on enemy routes); hidden until a route is set.
      const routeLine = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polyline",
      );
      routeLine.classList.add("openfront-helper-boat-route-polyline");
      routeLine.style.filter = "none";
      // SVG elements have no `hidden` IDL attribute (it lives on HTMLElement),
      // so `routeLine.hidden = true` is a no-op that leaves stale lines frozen
      // on screen. Hide via CSS `display`, which does apply to SVG.
      routeLine.style.display = "none";
      routeSvg.appendChild(routeLine);

      // Per-entry highlight ring at the boat's CURRENT position, shown whenever
      // the route shows — so an always-on route also marks the boat itself, and
      // hover/focus can make it stronger.
      const highlight = document.createElement("div");
      highlight.className = "openfront-helper-boat-highlight";
      highlight.hidden = true;
      container.appendChild(highlight);

      entry = {
        marker,
        routeLine,
        highlight,
        signature: "",
        markerVisible: false,
        markerX: "",
        markerY: "",
        routeVisible: false,
        routePoints: "",
        highlightVisible: false,
        highlightStrong: false,
        highlightX: "",
        highlightY: "",
      };
      boatPredictionDomCache.set(transport.domUnitId, entry);
    }

    const signature = `${transport.color}|${transport.bg}`;
    if (entry.signature !== signature) {
      entry.marker.style.setProperty("--boat-color", transport.color);
      entry.marker.style.setProperty("--boat-bg", transport.bg);
      entry.routeLine.style.stroke = transport.color;
      entry.highlight.style.setProperty("--boat-color", transport.color);
      entry.highlight.style.setProperty("--boat-bg", transport.bg);
      entry.signature = signature;
    }

    return entry;
  }

  function setBoatRouteVisible(entry, visible) {
    if (entry.routeVisible === visible) {
      return;
    }
    // CSS `display`, not `.hidden` — SVG polyline ignores the `hidden` property.
    entry.routeLine.style.display = visible ? "" : "none";
    entry.routeVisible = visible;
  }

  function setBoatMarkerVisible(entry, visible) {
    if (entry.markerVisible === visible) {
      return;
    }
    entry.marker.hidden = !visible;
    entry.markerVisible = visible;
  }

  function setBoatHighlightVisible(entry, visible) {
    if (entry.highlightVisible === visible) {
      return;
    }
    entry.highlight.hidden = !visible;
    entry.highlightVisible = visible;
  }

  function setBoatHighlightStrong(entry, strong) {
    if (entry.highlightStrong === strong) {
      return;
    }
    entry.highlight.classList.toggle("is-strong", strong);
    entry.highlightStrong = strong;
  }

  // Hide every layer of an entry at once (off-screen cull / teardown).
  function hideBoatEntry(entry) {
    setBoatMarkerVisible(entry, false);
    setBoatRouteVisible(entry, false);
    setBoatHighlightVisible(entry, false);
  }

  function updateBoatPredictionEntryPosition(entry, screenPos) {
    // Positions are baked into translate3d via CSS variables, not left/top.
    // Avoids per-frame paint invalidation of the marker (with its box-shadow)
    // when the camera pans.
    const x = `${screenPos.x}px`;
    const y = `${screenPos.y}px`;

    if (entry.markerX !== x) {
      entry.marker.style.setProperty("--boat-tx", x);
      entry.markerX = x;
    }
    if (entry.markerY !== y) {
      entry.marker.style.setProperty("--boat-ty", y);
      entry.markerY = y;
    }
  }

  function updateBoatHighlightPosition(entry, x, y) {
    const tx = `${x}px`;
    const ty = `${y}px`;
    if (entry.highlightX !== tx) {
      entry.highlight.style.setProperty("--boat-tx", tx);
      entry.highlightX = tx;
    }
    if (entry.highlightY !== ty) {
      entry.highlight.style.setProperty("--boat-ty", ty);
      entry.highlightY = ty;
    }
  }

  function cleanupBoatPredictionDomCache(activeTransportIds) {
    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!activeTransportIds.has(domUnitId)) {
        entry.marker.remove();
        entry.routeLine.remove();
        entry.highlight.remove();
        boatPredictionDomCache.delete(domUnitId);
      }
    }
  }

  function clearBoatPredictionHoverElements() {
    if (!boatPredictionHoverElements) {
      return;
    }
    boatPredictionHoverElements.label?.remove();
    boatPredictionHoverElements = null;
  }

  // Hover/focus owns only the label now; the highlight ring + route are drawn by
  // the boat's own per-entry elements (see syncBoatPrediction).
  function getBoatPredictionHoverElements(container) {
    if (!boatPredictionHoverElements) {
      const label = document.createElement("div");
      label.className = "openfront-helper-boat-label";
      container.appendChild(label);

      boatPredictionHoverElements = {
        label,
      };
    }

    return boatPredictionHoverElements;
  }

  function syncBoatPrediction() {
    // Frame skip: only render every 3rd rAF frame (~20fps). Scan still runs
    // at its own cadence. Blon pattern — smooth enough for boats, ~67% less CPU.
    _boatFrameCounter = (_boatFrameCounter + 1) % 3;
    if (_boatFrameCounter !== 0) {
      boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
      return;
    }

    if (!isBoatOverlayActive()) {
      teardownBoatOverlay();
      return;
    }

    const container = ensureBoatLandingContainer();
    ensureBoatMouseListener();
    const context = getOpenFrontGameContext();
    if (!context?.game || !context?.transform) {
      container.replaceChildren();
      lastBoatPredictionScanAt = 0;
      boatPredictionTransports = [];
      clearBoatPredictionDomCache();
      // Left the match (menu / between games): drop the warning baseline so the
      // next match seeds fresh instead of inheriting stale ids.
      resetIncomingBoatWarningBaseline();
      boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
      return;
    }

    const now = Date.now();
    if (!lastBoatPredictionScanAt || now - lastBoatPredictionScanAt >= BOAT_PREDICTION_SCAN_MS) {
      boatPredictionTransports = collectBoatPredictionTransports(context.game);
      const scanIds = new Set();
      for (const transport of boatPredictionTransports) {
        scanIds.add(transport.domUnitId);
      }
      cleanupBoatPredictionDomCache(scanIds);
      // Detection runs on the scan tick (~1s), off the per-frame path. Self-
      // gates on the warning toggle (defined in boat-panel.js, shared scope).
      maybeWarnNewIncomingBoats(boatPredictionTransports);
      lastBoatPredictionScanAt = now;
    }

    // The route SVG must exist before the loop: per-entry routes attach their
    // polylines to it, not just the hovered boat.
    const routeSvg = ensureBoatRouteSvg(container);

    resetScreenPointPool();

    // Landing markers + always-on routes only render with the prediction overlay
    // on. When only the panel is open the loop still runs, but the map stays
    // clean until a row is focused/hovered.
    const markersOn = boatPredictionEnabled;

    const visibleTransportIds = new Set();
    let mapHoveredId = null; // first boat under the mouse (overlay hover)
    // The accented boat (hovered or panel-focused) that owns the single label.
    let labelTransport = null;
    let labelLandingX = 0;
    let labelLandingY = 0;

    for (let i = 0; i < boatPredictionTransports.length; i += 1) {
      const transport = boatPredictionTransports[i];
      const isFocused =
        boatPanelFocusedId !== null && transport.domUnitId === boatPanelFocusedId;

      // Use pre-resolved world coords from the scan; avoids two proxy calls
      // (game.x, game.y) per transport per pan frame.
      const screenPos = toScreenPointFromWorld(
        context.transform,
        transport.targetWorldX,
        transport.targetWorldY,
      );
      // Focused boats are processed even off-screen (their boat/route may still
      // be partly visible); everything else is viewport-culled.
      if (!isFocused && !isNearViewport(screenPos, 200)) {
        continue;
      }
      const landingOnScreen = screenPos != null;
      // Capture landing coords now: the route computation below recycles the
      // screen-point pool, which would otherwise clobber screenPos.
      const landingX = landingOnScreen ? screenPos.x : 0;
      const landingY = landingOnScreen ? screenPos.y : 0;

      // Nothing renders for this boat unless the overlay is on (markers / always-
      // routes / map-hover) or it is the focused row. Skip all DOM work otherwise
      // — e.g. warning-only mode, or a panel with a different row focused — so no
      // hidden elements pile up for boats that never show.
      if (!markersOn && !isFocused) {
        const existing = boatPredictionDomCache.get(transport.domUnitId);
        if (existing) {
          hideBoatEntry(existing);
        }
        continue;
      }

      visibleTransportIds.add(transport.domUnitId);
      const entry = getBoatPredictionDomEntry(container, routeSvg, transport);

      // Landing marker: overlay-gated.
      if (markersOn && landingOnScreen) {
        setBoatMarkerVisible(entry, true);
        updateBoatPredictionEntryPosition(entry, screenPos);
      } else {
        setBoatMarkerVisible(entry, false);
      }

      // Map hover: only meaningful when overlay markers exist to hover over.
      let isMapHovered = false;
      if (markersOn && landingOnScreen && mapHoveredId === null) {
        const dx = landingX - boatLandingMouseX;
        const dy = landingY - boatLandingMouseY;
        if (dx * dx + dy * dy <= BOAT_LANDING_HOVER_RADIUS_SQUARED) {
          mapHoveredId = transport.domUnitId;
          isMapHovered = true;
        }
      }
      const isAccented = isMapHovered || isFocused; // stronger highlight + label

      // Draw route + boat highlight when the relation is always-on, or when the
      // boat is accented (hovered on the map / focused from the panel).
      if (shouldBoatRouteAlwaysShow(transport) || isAccented) {
        const boatScreenPosPooled = toScreenPoint(
          context.game,
          context.transform,
          asFiniteTileRef(transport.unit?.tile?.()),
        );
        // Copy pool coords out before getBoatRouteScreenPoints recycles slots.
        const hasBoatScreenPos = boatScreenPosPooled != null;
        const boatX = hasBoatScreenPos ? boatScreenPosPooled.x : 0;
        const boatY = hasBoatScreenPos ? boatScreenPosPooled.y : 0;
        const routePoints = getBoatRouteScreenPoints(
          context.game,
          context.transform,
          transport.unit,
          transport.motionPlanUnitId,
          hasBoatScreenPos ? { x: boatX, y: boatY } : null,
          landingOnScreen ? { x: landingX, y: landingY } : null,
        );

        if (routePoints.length >= 2) {
          let pointsAttr = "";
          for (let j = 0; j < routePoints.length; j += 1) {
            const p = routePoints[j];
            pointsAttr += j === 0 ? `${p.x},${p.y}` : ` ${p.x},${p.y}`;
          }
          if (entry.routePoints !== pointsAttr) {
            entry.routeLine.setAttribute("points", pointsAttr);
            entry.routePoints = pointsAttr;
          }
          setBoatRouteVisible(entry, true);
        } else {
          setBoatRouteVisible(entry, false);
        }

        // Highlight ring at the boat's current position (per-entry).
        if (hasBoatScreenPos) {
          updateBoatHighlightPosition(entry, boatX, boatY);
          setBoatHighlightStrong(entry, isAccented);
          setBoatHighlightVisible(entry, true);
        } else {
          setBoatHighlightVisible(entry, false);
        }

        if (isAccented && !labelTransport && landingOnScreen) {
          labelTransport = transport;
          labelLandingX = landingX;
          labelLandingY = landingY;
        }
      } else {
        setBoatRouteVisible(entry, false);
        setBoatHighlightVisible(entry, false);
      }
    }

    for (const [domUnitId, entry] of boatPredictionDomCache) {
      if (!visibleTransportIds.has(domUnitId)) {
        hideBoatEntry(entry);
      }
    }

    // Single label at the accented boat's landing point. The highlight ring and
    // route were already drawn by that boat's own per-entry elements.
    if (labelTransport) {
      const { color, labelText } = labelTransport;
      const hoverElements = getBoatPredictionHoverElements(container);
      hoverElements.label.hidden = false;
      hoverElements.label.style.setProperty("--boat-tx", `${labelLandingX}px`);
      hoverElements.label.style.setProperty("--boat-label-ty", `${labelLandingY - 16}px`);
      hoverElements.label.style.setProperty("--boat-color", color);
      // Append live ETA, e.g. "Your landing · Ky · 1m 32s".
      const etaText = formatBoatEta(computeBoatEtaMs(context.game, labelTransport));
      hoverElements.label.textContent = `${labelText} · ${etaText}`;
    } else {
      clearBoatPredictionHoverElements();
    }

    boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
  }

  function teardownBoatOverlay() {
    if (boatLandingAnimationFrame !== null) {
      cancelAnimationFrame(boatLandingAnimationFrame);
    }
    boatLandingAnimationFrame = null;
    lastBoatPredictionScanAt = 0;
    boatPredictionTransports = [];
    // Canvas cleanup
    var cvs = document.getElementById(BOAT_LANDING_CONTAINER_ID);
    if (cvs) cvs.remove();
    clearBoatPredictionDomCache();
    document.getElementById(BOAT_LANDING_CONTAINER_ID)?.remove();
  }

  // Start or tear down the shared overlay loop based on whether anything still
  // needs it (prediction overlay OR open panel). Both setters call this so the
  // loop and its container survive as long as either consumer is active.
  function refreshBoatOverlayActivity() {
    if (isBoatOverlayActive()) {
      if (boatLandingAnimationFrame === null) {
        syncBoatPrediction();
      }
    } else {
      teardownBoatOverlay();
    }
  }

  function setBoatPredictionEnabled(enabled, options) {
    const o = options || {};
    const nextAlwaysOwn = Boolean(o.alwaysOwnRoutes);
    const nextAlwaysTeam = Boolean(o.alwaysTeamRoutes);
    const nextAlwaysAlly = Boolean(o.alwaysAllyRoutes);
    const nextAlwaysEnemy = Boolean(o.alwaysEnemyRoutes);
    // A changed sub-option forces a re-scan so stale routes clear on the next
    // frame instead of waiting for the scan tick.
    const optionsChanged =
      nextAlwaysOwn !== boatPredictionAlwaysOwnRoutes ||
      nextAlwaysTeam !== boatPredictionAlwaysTeamRoutes ||
      nextAlwaysAlly !== boatPredictionAlwaysAllyRoutes ||
      nextAlwaysEnemy !== boatPredictionAlwaysEnemyRoutes;
    boatPredictionAlwaysOwnRoutes = nextAlwaysOwn;
    boatPredictionAlwaysTeamRoutes = nextAlwaysTeam;
    boatPredictionAlwaysAllyRoutes = nextAlwaysAlly;
    boatPredictionAlwaysEnemyRoutes = nextAlwaysEnemy;
    boatPredictionEnabled = Boolean(enabled);

    if (optionsChanged) {
      lastBoatPredictionScanAt = 0;
    }
    // Teardown is gated on the COMBINED activity, not just prediction: turning
    // the overlay off must not kill a loop/container the panel still needs.
    refreshBoatOverlayActivity();
  }

  // ── Canvas-based boat render (Blon port — replaces heavy DOM/SVG per-frame) ──
  if (typeof _boatUseCanvas !== "undefined" && _boatUseCanvas) {
    syncBoatPrediction = function _canvasBoatRender() {
      // Frame skip: render every 3rd rAF (~20fps)
      _boatFrameCounter = (_boatFrameCounter + 1) % 3;
      if (_boatFrameCounter !== 0) {
        boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
        return;
      }
      if (!isBoatOverlayActive()) { teardownBoatOverlay(); return; }
      ensureBoatMouseListener();

      // Canvas setup
      var cvs = document.getElementById(BOAT_LANDING_CONTAINER_ID);
      if (!cvs || cvs.tagName !== "CANVAS") {
        if (cvs) cvs.remove();
        cvs = document.createElement("canvas");
        cvs.id = BOAT_LANDING_CONTAINER_ID;
        cvs.setAttribute("aria-hidden", "true");
        cvs.style.cssText = "position:fixed;inset:0;z-index:8000;pointer-events:none;";
        (document.body || document.documentElement).appendChild(cvs);
      }
      var w = window.innerWidth, h = window.innerHeight;
      if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
      var ctx = cvs.getContext("2d");

      var context = getOpenFrontGameContext();
      if (!context?.game || !context?.transform) {
        ctx.clearRect(0, 0, w, h);
        lastBoatPredictionScanAt = 0; boatPredictionTransports = [];
        resetIncomingBoatWarningBaseline();
        boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
        return;
      }
      var game = context.game, transform = context.transform;

      var now = Date.now();
      if (!lastBoatPredictionScanAt || now - lastBoatPredictionScanAt >= BOAT_PREDICTION_SCAN_MS) {
        boatPredictionTransports = collectBoatPredictionTransports(game);
        maybeWarnNewIncomingBoats(boatPredictionTransports);
        lastBoatPredictionScanAt = now;
      }

      var markersOn = boatPredictionEnabled;
      var ownAlways = boatPredictionAlwaysOwnRoutes, teamAlways = boatPredictionAlwaysTeamRoutes;
      var allyAlways = boatPredictionAlwaysAllyRoutes, enemyAlways = boatPredictionAlwaysEnemyRoutes;
      ctx.clearRect(0, 0, w, h);
      resetScreenPointPool();

      // Hover detection
      var hoverIdx = -1;
      var hoverDist = BOAT_LANDING_HOVER_RADIUS_PX * BOAT_LANDING_HOVER_RADIUS_PX;
      if (markersOn) {
        for (var hi = 0; hi < boatPredictionTransports.length; hi++) {
          var ht = boatPredictionTransports[hi];
          var hsp = toScreenPointFromWorld(transform, ht.targetWorldX, ht.targetWorldY);
          if (!hsp) continue;
          var hdx = hsp.x - boatLandingMouseX, hdy = hsp.y - boatLandingMouseY;
          if (hdx * hdx + hdy * hdy < hoverDist) { hoverDist = hdx * hdx + hdy * hdy; hoverIdx = hi; }
        }
      }

      for (var i = 0; i < boatPredictionTransports.length; i++) {
        var t = boatPredictionTransports[i];
        var sp = toScreenPointFromWorld(transform, t.targetWorldX, t.targetWorldY);
        if (!sp || !isNearViewport(sp, 120)) continue;
        // Snapshot now: route sampling below recycles the shared 3-slot screen-
        // point pool, which would otherwise clobber sp's x/y in place — the
        // symptom was the marker/label/route endpoint jittering in step with
        // the boat's own tick-based movement (more/fewer path samples = more/
        // fewer pool reuses before sp was read again).
        var spx = sp.x, spy = sp.y;

        var alwaysShow = t.relation === "self" ? ownAlways
          : t.relation === "team" ? teamAlways
          : t.relation === "ally" ? allyAlways : enemyAlways;
        var isHovered = i === hoverIdx;
        var color = t.color;

        // Marker: circle + crosshair (Blon pattern) — always shown; hover-only
        // detail (route + ETA label) is added below.
        if (markersOn) {
          ctx.beginPath(); ctx.arc(spx, spy, 8, 0, Math.PI * 2);
          ctx.fillStyle = t.bg; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(spx - 5, spy); ctx.lineTo(spx + 5, spy);
          ctx.moveTo(spx, spy - 5); ctx.lineTo(spx, spy + 5);
          ctx.lineWidth = 1.5; ctx.stroke();
        }

        // Route line: drawn on hover, or persistently when the relation's
        // "always show routes" toggle is on.
        if (alwaysShow || isHovered) {
          var rpts = getBoatRouteScreenPoints(game, transform, t.unit, t.motionPlanUnitId, null, { x: spx, y: spy });
          if (rpts.length >= 2) {
            ctx.beginPath(); ctx.moveTo(rpts[0].x, rpts[0].y);
            for (var rj = 1; rj < rpts.length; rj++) ctx.lineTo(rpts[rj].x, rpts[rj].y);
            ctx.strokeStyle = color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
          }
        }

        // ETA label: hover-only, regardless of the "always show routes" toggle
        // — that toggle should only keep the route line visible, not the detail.
        if (isHovered) {
          var etaMs = computeBoatEtaMs(game, t);
          var etaText = typeof formatBoatEta === "function" ? formatBoatEta(etaMs) : (etaMs != null ? (etaMs / 1000).toFixed(1) + "s" : "");
          var fullLabel = t.labelText + " · " + etaText;
          ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          var tw2 = ctx.measureText(fullLabel).width, ly = spy - 14;
          ctx.fillStyle = "rgba(0,0,0,0.72)";
          ctx.fillRect(spx - tw2 / 2 - 4, ly - 12, tw2 + 8, 14);
          ctx.fillStyle = color; ctx.fillText(fullLabel, spx, ly);
        }
      }
      boatLandingAnimationFrame = requestAnimationFrame(syncBoatPrediction);
    };
  }
