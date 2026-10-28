// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/auto-bot/nukeBehavior.js (lines 95-321) + auto-bot/portutil.js (within, lines 146-150)
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: only the Bezier curve helpers, the parabola path finder and the UniversalPathFinding factory (pure math, used by nuke-trajectory) plus within(); the rest of the auto-bot (and its "use strict") is not included.

  // ===========================================================================
  // Bezier curve helpers — src/core/utilities/Line.ts (ported VERBATIM, only TS
  // types dropped). CubicBezierCurve + DistanceBasedBezierCurve back the parabola
  // path finder. (BezenhamLine is not needed by the nuke behavior and is omitted.)
  // ===========================================================================
  class NukeCubicBezierCurve {
    constructor(p0, p1, p2, p3) {
      this.p0 = p0;
      this.p1 = p1;
      this.p2 = p2;
      this.p3 = p3;
    }
    getPointAt(t) {
      const T = 1 - t;
      const TT = T * T;
      const TTT = TT * T;
      const tt = t * t;
      const ttt = tt * t;

      const x =
        TTT * this.p0.x +
        3 * TT * t * this.p1.x +
        3 * T * tt * this.p2.x +
        ttt * this.p3.x;

      const y =
        TTT * this.p0.y +
        3 * TT * t * this.p1.y +
        3 * T * tt * this.p2.y +
        ttt * this.p3.y;
      return { x, y };
    }
  }

  /**
   *  Use a cumulative distance LUT to approximate the traveled distance
   *  Useful to compute regular steps based on the curve rather than a t
   */
  class NukeDistanceBasedBezierCurve extends NukeCubicBezierCurve {
    constructor(p0, p1, p2, p3, distanceIncrement) {
      super(p0, p1, p2, p3);
      this.totalDistance = 0;
      this.cachedPoints = [];
      this.currentIndex = 0;
      this.computeAllPoints(distanceIncrement, 0.002);
    }

    getAllPoints() {
      return this.cachedPoints;
    }
    /**
     * Move forward along the curve by the given distance.
     * Returns the next cached point, or null if at the end.
     */
    increment(distance) {
      this.totalDistance += distance;

      // Step forward through cached points until we're at the correct distance
      while (
        this.currentIndex < this.cachedPoints.length - 1 &&
        this.getDistanceUpToIndex(this.currentIndex + 1) < this.totalDistance
      ) {
        this.currentIndex++;
      }

      if (this.currentIndex >= this.cachedPoints.length - 1) {
        return null; // End of curve
      }

      return this.cachedPoints[this.currentIndex];
    }

    getCurrentIndex() {
      return this.currentIndex;
    }

    /**
     * Precompute all points spaced @p pixelSpacing apart
     */
    computeAllPoints(pixelSpacing, precision) {
      this.cachedPoints = [];
      this.totalDistance = 0;
      this.currentIndex = 0;

      let t = 0;
      let prevPoint = this.getPointAt(t);
      this.cachedPoints.push(prevPoint);

      let cumulativeDistance = 0;

      while (t < 1) {
        t = Math.min(t + precision, 1);
        const currentPoint = this.getPointAt(t);

        const dx = currentPoint.x - prevPoint.x;
        const dy = currentPoint.y - prevPoint.y;
        const segmentLength = Math.sqrt(dx * dx + dy * dy);
        cumulativeDistance += segmentLength;

        if (cumulativeDistance >= pixelSpacing) {
          this.cachedPoints.push(currentPoint);
          cumulativeDistance = 0;
        }

        prevPoint = currentPoint;
      }

      // Make sure the last point is exactly at t=1
      const finalPoint = this.getPointAt(1);
      if (
        this.cachedPoints.length === 0 ||
        finalPoint.x !== this.cachedPoints[this.cachedPoints.length - 1].x ||
        finalPoint.y !== this.cachedPoints[this.cachedPoints.length - 1].y
      ) {
        this.cachedPoints.push(finalPoint);
      }
    }

    /**
     * Optional helper: get distance along the cached points up to a given index
     */
    getDistanceUpToIndex(index) {
      let dist = 0;
      for (let i = 1; i <= index; i++) {
        const p1 = this.cachedPoints[i - 1];
        const p2 = this.cachedPoints[i];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        dist += Math.sqrt(dx * dx + dy * dy);
      }
      return dist;
    }
  }

  // ===========================================================================
  // ParabolaUniversalPathFinder — src/core/pathfinding/PathFinder.Parabola.ts
  // (ported VERBATIM, only TS types + SteppingPathFinder interface dropped). Only
  // findPath() is used by the nuke behavior, but next()/invalidate()/currentIndex()
  // are ported too for faithfulness. Constructed via the UniversalPathFinding
  // .Parabola(game, opts) factory below (mirroring src's UniversalPathFinding).
  // ===========================================================================
  const PARABOLA_MIN_HEIGHT = 50;

  class NukeParabolaUniversalPathFinder {
    constructor(gameMap, options) {
      this.gameMap = gameMap;
      this.options = options;
      this.curve = null;
      this.lastTo = null;
    }

    createCurve(from, to) {
      const increment = this.options?.increment ?? 3;
      const distanceBasedHeight = this.options?.distanceBasedHeight ?? true;
      const directionUp = this.options?.directionUp ?? true;

      const p0 = { x: this.gameMap.x(from), y: this.gameMap.y(from) };
      const p3 = { x: this.gameMap.x(to), y: this.gameMap.y(to) };
      const dx = p3.x - p0.x;
      const dy = p3.y - p0.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const maxHeight = distanceBasedHeight
        ? Math.max(distance / 3, PARABOLA_MIN_HEIGHT)
        : 0;
      const heightMult = directionUp ? -1 : 1;
      const mapHeight = this.gameMap.height();

      const p1 = {
        x: p0.x + dx / 4,
        y: within(p0.y + dy / 4 + heightMult * maxHeight, 0, mapHeight - 1),
      };
      const p2 = {
        x: p0.x + (dx * 3) / 4,
        y: within(p0.y + (dy * 3) / 4 + heightMult * maxHeight, 0, mapHeight - 1),
      };

      return new NukeDistanceBasedBezierCurve(p0, p1, p2, p3, increment);
    }

    findPath(from, to) {
      if (Array.isArray(from)) {
        throw new Error(
          "ParabolaUniversalPathFinder does not support multiple start points",
        );
      }
      const curve = this.createCurve(from, to);
      return curve
        .getAllPoints()
        .map((p) => this.gameMap.ref(Math.floor(p.x), Math.floor(p.y)));
    }

    next(from, to, speed) {
      if (this.lastTo !== to) {
        this.curve = this.createCurve(from, to);
        this.lastTo = to;
      }

      const nextPoint = this.curve.increment(speed ?? 1);
      if (!nextPoint) {
        // src returns { status: PathStatus.COMPLETE, node: to }
        return { status: "Complete", node: to };
      }
      const tile = this.gameMap.ref(
        Math.floor(nextPoint.x),
        Math.floor(nextPoint.y),
      );
      // src returns { status: PathStatus.NEXT, node: tile }
      return { status: "Next", node: tile };
    }

    invalidate() {
      this.curve = null;
      this.lastTo = null;
    }

    currentIndex() {
      return this.curve?.getCurrentIndex() ?? 0;
    }
  }

  // UniversalPathFinding.Parabola factory — src/core/pathfinding/PathFinder.ts.
  // src calls `UniversalPathFinding.Parabola(this.game, opts)`; mirror it.
  const UniversalPathFinding = {
    Parabola(gameMap, options) {
      return new NukeParabolaUniversalPathFinder(gameMap, options);
    },
  };

  // within — src/core/Util.ts:37 (clamp; named `within` to keep src parity;
  // helpers.js already defines `clamp` with the same semantics).
  function within(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
