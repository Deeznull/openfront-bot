// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/map-overlay-scheduler.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Shared map-overlay scheduler.
//
// The compounding lag from many overlays comes from N separate rAF loops + N
// getOpenFrontGameContext() calls + N world→screen passes, not from DOM itself.
// This module runs ONE rAF loop, fetches the game context ONCE per frame, and
// hands every registered layer a shared 2D canvas to draw on. New high-node-count
// overlays (per-player troop bars, money tags, threat icons for 50+ players every
// frame) draw here instead of spawning hundreds of DOM nodes. Existing optimized
// overlays (nuke/warship/boat) keep their own loops untouched — this is additive.
//
// A layer is: { id, isEnabled(): bool, scanIntervalMs?, scan?(game, transform, now),
//               draw(ctx, game, transform, now) }
// scan() runs on a throttle (default 250ms) for expensive proxy reads; draw()
// runs every frame from the layer's own cache. The loop auto-stops when no layer
// is enabled and tears the canvas down.

  const MAP_OVERLAY_CANVAS_ID = "openfront-helper-map-overlay-canvas";
  const MAP_OVERLAY_DEFAULT_SCAN_MS = 250;
  const _mapOverlayLayers = [];
  let _mapOverlayCanvas = null;
  let _mapOverlayCtx = null;
  let _mapOverlayFrame = null;
  let _mapOverlayCssW = 0;
  let _mapOverlayCssH = 0;
  // Low-lag mode: skip 2 of every 3 animation frames (throttle rAF to ~20fps).
  // Cached (reading localStorage every frame would itself cost) and refreshed
  // every ~1s from the persisted settings, so the toggle applies without reload.
  let _mapOverlayFrameCounter = 0;
  let _lowLagCached = false;
  let _lowLagCheckedAt = 0;
  function _isLowLagMode() {
    var now = performance.now();
    if (now - _lowLagCheckedAt > 1000) {
      _lowLagCheckedAt = now;
      try {
        var raw = localStorage.getItem("ofh:settings");
        _lowLagCached = raw ? !!(JSON.parse(raw) || {}).lowLagMode : false;
      } catch (_e) { _lowLagCached = false; }
    }
    return _lowLagCached;
  }
  // Redraw-on-dirty state: we only clear+redraw when something actually changed
  // (camera moved, a layer scanned, canvas resized, or a layer was just enabled).
  // A static camera then costs almost nothing — this is the main anti-lag lever.
  let _mapOverlayDirty = true;
  let _mapOverlayLastCamSig = "";
  let _mapOverlayHadContext = false;
  // Reused input object for worldToScreenCoordinates so the per-player hot loop
  // does not allocate a point per player per frame.
  const _mapOverlayWorldArg = { x: 0, y: 0 };
  const _mapOverlayCamProbe = { x: 0, y: 0 };

  // Cache the game's transform object (NOT screen coords) to avoid a DOM lookup
  // per world→screen call. Tactical Assistant's smoothness comes from this: the
  // transform object is stable across pan/zoom, so caching it for 250ms removes
  // ~1000 getOpenFrontGameContext() DOM scans per frame while positions stay live.
  let _mapOverlayCachedTransform = null;
  let _mapOverlayCachedTransformAt = 0;
  const MAP_OVERLAY_TRANSFORM_CACHE_MS = 250;

  function registerMapOverlayLayer(layer) {
    if (!layer || typeof layer.draw !== "function") {
      return;
    }
    layer._lastScanAt = 0;
    layer.scanIntervalMs =
      typeof layer.scanIntervalMs === "number"
        ? layer.scanIntervalMs
        : MAP_OVERLAY_DEFAULT_SCAN_MS;
    // animated:true layers redraw every frame (e.g. pulsing rings); everything
    // else is dirty-gated. Default false = gated (the heavy layers).
    layer.animated = layer.animated === true;
    _mapOverlayLayers.push(layer);
  }

  // Mark the overlay dirty so the next frame redraws. Called on enable/disable.
  function markMapOverlayDirty() {
    _mapOverlayDirty = true;
  }

  function anyMapOverlayLayerEnabled() {
    for (let i = 0; i < _mapOverlayLayers.length; i += 1) {
      try {
        if (_mapOverlayLayers[i].isEnabled()) {
          return true;
        }
      } catch (_error) {
        // A misbehaving predicate must not wedge the loop.
      }
    }
    return false;
  }

  function ensureMapOverlayCanvas() {
    if (!_mapOverlayCanvas || !_mapOverlayCanvas.isConnected) {
      _mapOverlayCanvas = document.getElementById(MAP_OVERLAY_CANVAS_ID);
    }
    if (!_mapOverlayCanvas) {
      _mapOverlayCanvas = document.createElement("canvas");
      _mapOverlayCanvas.id = MAP_OVERLAY_CANVAS_ID;
      _mapOverlayCanvas.setAttribute("aria-hidden", "true");
      // Below the DOM overlay layers (nuke ...646 / warship ...645) so their
      // markers stay on top; still well above the game canvas.
      _mapOverlayCanvas.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;z-index:500;pointer-events:none;";
      (document.body || document.documentElement).appendChild(_mapOverlayCanvas);
      _mapOverlayCtx = null;
    }
    if (!_mapOverlayCtx) {
      _mapOverlayCtx = _mapOverlayCanvas.getContext("2d");
    }
    // Backing store = CSS pixels (NO devicePixelRatio). This is deliberate and
    // matches Tactical Assistant: on hi-dpi displays a dpr-scaled canvas has to
    // fill 4× the pixels, which is the single biggest overlay lag source. We
    // trade a little text crispness for a large fill-rate win.
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    if (cssW !== _mapOverlayCssW || cssH !== _mapOverlayCssH) {
      _mapOverlayCssW = cssW;
      _mapOverlayCssH = cssH;
      _mapOverlayCanvas.width = cssW;
      _mapOverlayCanvas.height = cssH;
      _mapOverlayDirty = true; // resize wipes the canvas → must redraw
    }
    return _mapOverlayCanvas;
  }

  function teardownMapOverlayCanvas() {
    if (_mapOverlayCanvas) {
      _mapOverlayCanvas.remove();
    }
    _mapOverlayCanvas = null;
    _mapOverlayCtx = null;
    _mapOverlayCssW = 0;
    _mapOverlayCssH = 0;
    _mapOverlayHadContext = false;
    _mapOverlayLastCamSig = "";
  }

  // A cheap signature of the current camera: project one fixed world point and
  // read the transform scale. When either changes, the camera panned/zoomed and
  // we must redraw. One transform call per frame instead of thousands.
  function computeCameraSignature(transform) {
    let sx = 0;
    let sy = 0;
    try {
      _mapOverlayCamProbe.x = 0;
      _mapOverlayCamProbe.y = 0;
      const p = transform.worldToScreenCoordinates(_mapOverlayCamProbe);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        sx = p.x;
        sy = p.y;
      }
    } catch (_error) {
      /* keep zeros */
    }
    let scale = 1;
    try {
      const s = Number(transform.scale);
      if (Number.isFinite(s)) scale = s;
    } catch (_error) {
      /* keep 1 */
    }
    return `${Math.round(sx)},${Math.round(sy)},${scale}`;
  }

  function _mapOverlayTick() {
    if (!anyMapOverlayLayerEnabled()) {
      teardownMapOverlayCanvas();
      _mapOverlayFrame = null;
      return;
    }

    // Low-lag mode: process only every 3rd frame (~20fps) to cut CPU on the
    // shared overlay loop. Still schedules the next rAF so it stays responsive.
    if (_isLowLagMode()) {
      _mapOverlayFrameCounter++;
      if (_mapOverlayFrameCounter % 3 !== 0) {
        _mapOverlayFrame = requestAnimationFrame(_mapOverlayTick);
        return;
      }
    }

    ensureMapOverlayCanvas();
    const ctx = _mapOverlayCtx;
    if (ctx) {
      let context = null;
      try {
        context = getOpenFrontGameContext();
      } catch (_error) {
        context = null;
      }

      if (context && context.game && context.transform) {
        if (!_mapOverlayHadContext) {
          _mapOverlayHadContext = true;
          _mapOverlayDirty = true; // first frame with a live game → draw
        }
        const now = performance.now();

        // 1) Run due scans (throttled per layer). A scan that runs makes the
        //    frame dirty because the cached data changed.
        let anyAnimated = false;
        for (let i = 0; i < _mapOverlayLayers.length; i += 1) {
          const layer = _mapOverlayLayers[i];
          let enabled = false;
          try {
            enabled = layer.isEnabled();
          } catch (_error) {
            enabled = false;
          }
          if (!enabled) continue;
          if (layer.animated) anyAnimated = true;
          if (
            typeof layer.scan === "function" &&
            now - layer._lastScanAt >= layer.scanIntervalMs
          ) {
            try {
              layer.scan(context.game, context.transform, now);
            } catch (error) {
              console.error("OpenFront map-overlay scan failed:", layer.id, error);
            }
            layer._lastScanAt = now;
            _mapOverlayDirty = true;
          }
        }

        // 2) Camera-move detection: one transform call per frame.
        const camSig = computeCameraSignature(context.transform);
        if (camSig !== _mapOverlayLastCamSig) {
          _mapOverlayLastCamSig = camSig;
          _mapOverlayDirty = true;
        }

        // 3) Only clear+redraw when dirty, or when an animated layer is on.
        if (_mapOverlayDirty || anyAnimated) {
          if (typeof resetScreenPointPool === "function") {
            resetScreenPointPool();
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, _mapOverlayCssW, _mapOverlayCssH);
          for (let i = 0; i < _mapOverlayLayers.length; i += 1) {
            const layer = _mapOverlayLayers[i];
            let enabled = false;
            try {
              enabled = layer.isEnabled();
            } catch (_error) {
              enabled = false;
            }
            if (!enabled) continue;
            try {
              layer.draw(ctx, context.game, context.transform, now);
            } catch (error) {
              console.error("OpenFront map-overlay draw failed:", layer.id, error);
            }
          }
          _mapOverlayDirty = false;
        }
      } else if (_mapOverlayHadContext) {
        // Lost the game (match ended) — clear once and reset.
        _mapOverlayHadContext = false;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, _mapOverlayCssW, _mapOverlayCssH);
        _mapOverlayLastCamSig = "";
      }
    }

    _mapOverlayFrame = requestAnimationFrame(_mapOverlayTick);
  }

  // Call after enabling/disabling any layer. Starts the shared loop if something
  // is now on; the loop stops itself on the next frame when everything is off.
  function requestMapOverlayLoop() {
    _mapOverlayDirty = true; // an enable/disable happened → force one redraw
    if (_mapOverlayFrame === null && anyMapOverlayLayerEnabled()) {
      _mapOverlayFrame = requestAnimationFrame(_mapOverlayTick);
    }
  }

  // ---- Shared drawing helpers (keep every layer visually consistent) ----

  // Faction palette — identical values to boat-prediction / warship-routes so the
  // whole helper reads as one system.
  function mapFactionColor(relation) {
    switch (relation) {
      case "self":
        return "rgba(96, 165, 250, 0.95)"; // blue
      case "team":
        return "rgba(45, 212, 191, 0.95)"; // teal
      case "ally":
        return "rgba(74, 222, 128, 0.95)"; // green
      case "neutralEnemy":
        return "rgba(250, 204, 21, 0.95)"; // yellow (enemy not targeting you)
      default:
        return "rgba(248, 113, 113, 0.95)"; // enemy red
    }
  }

  // World point → screen point via the shared reused arg. Returns null when the
  // transform rejects the point.
  function mapWorldToScreen(transform, worldX, worldY) {
    _mapOverlayWorldArg.x = worldX;
    _mapOverlayWorldArg.y = worldY;
    try {
      const p = transform.worldToScreenCoordinates(_mapOverlayWorldArg);
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
        return null;
      }
      return p;
    } catch (_error) {
      return null;
    }
  }

  // Fast batch projector: the game transform is affine (translate + uniform
  // scale, no rotation), so we can derive it from 3 sample points ONCE and then
  // project thousands of cells with plain arithmetic instead of thousands of
  // worldToScreenCoordinates calls. This is what makes the spawn heatmap (~1200
  // cells) smooth while panning. Returns null if the transform can't be sampled.
  const _mapProjectorRef = { ox: 0, oy: 0, sx: 1, sy: 1 };
  function mapMakeProjector(transform) {
    const a = mapWorldToScreen(transform, 0, 0);
    if (!a) return null;
    const bx = mapWorldToScreen(transform, 1000, 0);
    const cy = mapWorldToScreen(transform, 0, 1000);
    if (!bx || !cy) return null;
    _mapProjectorRef.ox = a.x;
    _mapProjectorRef.oy = a.y;
    _mapProjectorRef.sx = (bx.x - a.x) / 1000;
    _mapProjectorRef.sy = (cy.y - a.y) / 1000;
    return _mapProjectorRef;
  }
  // Project a world coord with a projector from mapMakeProjector into (out.x,out.y).
  function mapProject(proj, worldX, worldY, out) {
    out.x = proj.ox + worldX * proj.sx;
    out.y = proj.oy + worldY * proj.sy;
    return out;
  }

  function mapPointOnScreen(x, y, pad = 40) {
    return (
      x >= -pad &&
      y >= -pad &&
      x <= _mapOverlayCssW + pad &&
      y <= _mapOverlayCssH + pad
    );
  }

  // Text with a dark halo so it stays readable over any territory color. Matches
  // the DOM label look (font 900 11px, dark outline) used by boat/nuke labels.
  function drawMapHaloText(ctx, x, y, text, color, options) {
    const opts = options || {};
    const font = opts.font || '900 11px "Aptos", "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.font = font;
    ctx.textAlign = opts.align || "center";
    ctx.textBaseline = opts.baseline || "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = opts.haloWidth || 3;
    ctx.strokeStyle = opts.halo || "rgba(0, 0, 0, 0.9)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color || "#e2e8f0";
    ctx.fillText(text, x, y);
  }
