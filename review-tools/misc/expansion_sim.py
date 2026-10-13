#!/usr/bin/env python
"""
expansion_sim.py - early-expansion simulator for OpenFront v0.34 (solo player, wilderness only).
Run with:  python -I tools/expansion_sim.py [--all | --calib | --validate | --one ...]
Standard library only.

ENGINE FORMULAS MIRRORED (all troop numbers RAW; HUD shows raw/10; 1 tick = 100 ms = 0.1 s)
  maxTroops   Config.ts:1024-1034   M = 2*(tiles^0.6*1000 + 50000) + 250000*cityLevels   (human)
  regen       Config.ts:1058-1090   g = (10 + T^0.73/4) * (1 - T/M),  T = HOME troops only
  gold        Config.ts:1092-1100   100 gold/tick flat (1,000/s) for a human; City 125K x 2^n (Config.ts:670-676)
  wilderness  Config.ts:896-908     loss/tile = mag/5 (plains 16, highland 20, mountain 24)
                                    tickFraction = clamp(2000*tileCost/attackTroops, 5, 100) / (2*borderSize)
  terrain     Config.ts:172-186     plains (80,16.5) highland (100,20) mountain (120,25)
  tick loop   AttackExecution.ts:285-330   borderSize = frontier tiles + rand(0..4), fixed for the tick;
                                    tiles are conquered until sum(tickFraction) >= 1
  queue order AttackExecution.ts:405-440   priority = (rand(0..6)+10)*(1 - ownedNbrs*0.5 + mag/2) + tick
  launch      AttackExecution.ts:~123      sent troops leave HOME at once (owner.removeTroops); they do not regen
  retreat     AttackExecution.ts:~170-200  when no wilderness is left the survivors return home
  spawn       Util.ts:130-159 / SpawnExecution: disc of radius 4 (~50 tiles); PlayerExecution is inactive in the
              spawn phase (PlayerExecution.ts:34), so t=0 here is the END of the spawn phase, T0 = 25,000 raw.

SIMPLIFICATIONS (be aware):
  * Solo player, nobody else exists: no Tribes, Nations, humans, no losses to attackers, no alliances.
  * Wilderness only. Terrain per tile is i.i.d. from the chosen mix (real maps have patches). The queue
    priority prefers plains slightly, but all reachable tiles are eventually taken; this is modelled by the grid
    engine (--validate) and ignored by the fast model, which samples tile terrain i.i.d.
  * Fast model: frontier size B = C_BORDER*sqrt(A)*open_frac (C fitted from the grid engine, --calib).
    Real borders on coast/mixed terrain are smaller/ragged; that mostly lowers the speed cap.
  * Decisions are made every DEC ticks (default 10 = 1 s). A human clicking every ~3 s should use --dec 30.
    Each click merges into the running wilderness attack (AttackExecution.ts:140-155), so one pool is modelled.
  * Boats, Ports, Factories, structure building time (City: 20 ticks) and gold from Tribe kills are not modelled
    except as a fixed 'City finishes at t seconds' input.
  * Returning troops can overshoot max (then bleed); modelled via the engine formula (negative regen above M).
  * Troop counts are floats (engine floors them: negligible).
"""
import argparse
import math
import random
import sys
import heapq

TPS = 10  # ticks per second
TERR = {0: (80.0, 16.5), 1: (100.0, 20.0), 2: (120.0, 25.0)}  # (mag, tileCost) Config.ts:172-186
MIXES = {
    "plains": (1.0, 0.0, 0.0),
    "highland": (0.0, 1.0, 0.0),
    "mountain": (0.0, 0.0, 1.0),
    "mixed": (0.5, 0.3, 0.2),
}
START_T = 25000.0
START_A = 50
C_BORDER = 3.65  # fitted by --calib (frontier tiles ~ C*sqrt(area)); see grid engine below


def max_troops(A, city_levels):
    return 2.0 * (A ** 0.6 * 1000.0 + 50000.0) + 250000.0 * city_levels


def regen(T, M):
    add = (10.0 + max(T, 0.0) ** 0.73 / 4.0) * (1.0 - T / M)
    return min(T + add, M) - T


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def sample_terrain(rng, mix):
    r = rng.random()
    if r < mix[0]:
        return 0
    if r < mix[0] + mix[1]:
        return 1
    return 2


# ----------------------------------------------------------------------------------------------
# Strategies. Each returns the number of RAW troops to send this decision (0 = none).
# ----------------------------------------------------------------------------------------------
class Strat:
    name = "?"

    def decide(self, st):
        return 0.0


class Threshold(Strat):
    """(a) wait until home >= X of max, then send Y of HOME troops."""

    def __init__(self, X, Y):
        self.X, self.Y = X, Y
        self.name = "wait%d/send%d" % (round(X * 100), round(Y * 100))

    def decide(self, st):
        if st.T >= self.X * st.M:
            return self.Y * st.T
        return 0.0


class Floor(Strat):
    """(b) continuous: send whatever is above F*max (keeps home at the floor F; F=0.42 = regen peak).
    F=0.60 is the R10 'home floor 60%'; F=0.40 is E22 A."""

    def __init__(self, F, minsend=0.0, cap_abs=None):
        self.F, self.minsend, self.cap_abs = F, minsend, cap_abs
        self.name = "floor%d" % round(F * 100) + ("" if not minsend else "+min%d" % minsend)

    def decide(self, st):
        s = st.T - self.F * st.M
        if s < self.minsend:
            return 0.0
        return s


class FloorDecay(Strat):
    """(c) mixed: burst of X0 of home at t=0 (fast land seed), then Floor(F)."""

    def __init__(self, burst, F):
        self.burst, self.F = burst, F
        self.name = "burst%d+floor%d" % (round(burst * 100), round(F * 100))

    def decide(self, st):
        if st.tick == 0:
            return self.burst * st.T
        s = st.T - self.F * st.M
        return s if s > 0 else 0.0


class Piecewise(Strat):
    """(c) mixed: floor schedule [(from_second, F), ...], e.g. 0.20 for 0-60 s, then 0.30, then 0.42."""

    def __init__(self, sched):
        self.sched = sched
        self.name = "sched" + "/".join("%d@%ds" % (round(f * 100), t) for t, f in sched)

    def decide(self, st):
        F = self.sched[0][1]
        for t, f in self.sched:
            if st.tick >= t * TPS:
                F = f
        s = st.T - F * st.M
        return s if s > 0 else 0.0


class FloorNoCity(Strat):
    """(c) mixed: floor F computed on the max WITHOUT the City (so a new City does not freeze sending)."""

    def __init__(self, F):
        self.F = F
        self.name = "floor%d(noCityM)" % round(F * 100)

    def decide(self, st):
        M0 = max_troops(st.A, 0)
        s = st.T - self.F * M0
        return s if s > 0 else 0.0


class FloorAbs(Strat):
    """(c) mixed: keep an ABSOLUTE reserve of R raw troops at home (e.g. 2x a Tribe's send), nothing else."""

    def __init__(self, R):
        self.R = R
        self.name = "reserve%dK" % round(R / 1000)

    def decide(self, st):
        s = st.T - self.R
        return s if s > 0 else 0.0


# ----------------------------------------------------------------------------------------------
# Fast abstract model
# ----------------------------------------------------------------------------------------------
class State:
    pass


def run_fast(strat, mixname="mixed", city_t=None, land_cap=10 ** 9, open_frac=1.0, dec=10,
             seconds=180, seed=1, spawn_A=START_A):
    rng = random.Random(seed)
    mix = MIXES[mixname]
    st = State()
    st.T, st.A, st.pool, st.tick = START_T, spawn_A, 0.0, 0
    st.cities = 0
    st.avail = land_cap
    st.M = max_troops(st.A, st.cities)
    st.minfill = 9.9
    st.minT = 1e18
    st.wall = None
    st.sentclicks = 0
    snaps = {}
    city_tick = None if city_t is None else int(city_t * TPS)
    pending_city = None
    first_full_tick = None
    idle_ticks_over_60 = 0
    for tk in range(seconds * TPS + 1):
        st.tick = tk
        # --- structure completion
        if city_tick is not None and tk == city_tick:
            pending_city = tk + 20  # construction 2 s (Config.ts:676)
        if pending_city is not None and tk == pending_city:
            st.cities += 1
            pending_city = None
        st.M = max_troops(st.A, st.cities)
        # --- decision
        if tk % dec == 0 and st.avail > 0:
            s = strat.decide(st)
            s = min(s, st.T)
            if s >= 1:
                st.T -= s
                st.pool += s
                st.sentclicks += 1
        # --- attack tick (AttackExecution.tick), wilderness branch of attackLogic
        if st.pool >= 1:
            B = max(1.0, C_BORDER * math.sqrt(st.A) * open_frac) + rng.randint(0, 4)
            budget = 1.0
            while budget > 0:
                if st.pool < 1:
                    st.pool = 0.0
                    break
                if st.avail <= 0:
                    st.T += st.pool  # retreat(): survivors return home
                    st.pool = 0.0
                    break
                t = sample_terrain(rng, mix)
                mag, tc = TERR[t]
                budget -= clamp(2000.0 * tc / st.pool, 5.0, 100.0) / (2.0 * B)
                st.pool -= mag / 5.0
                st.A += 1
                st.avail -= 1
        elif st.pool > 0:
            st.pool = 0.0
        # --- regen (PlayerExecution.tick), after the attack tick of the same tick is close enough
        st.M = max_troops(st.A, st.cities)
        st.T += regen(st.T, st.M)
        if tk >= 30 * TPS:  # safety stat after the first 30 s
            st.minfill = min(st.minfill, st.T / st.M)
            st.minT = min(st.minT, st.T)
        if tk % (10 * TPS) == 0 and tk > 0:
            snaps[tk // TPS] = (st.A, st.M, st.T, st.pool, st.cities)
        if st.avail <= 0 and first_full_tick is None:
            first_full_tick = tk
            st.wall = (tk / TPS, st.T, st.M, st.pool)
    st.snaps = snaps
    st.first_full = None if first_full_tick is None else first_full_tick / TPS
    return st


def fmt(st, secs=(60, 120, 180)):
    out = []
    for s in secs:
        A, M, T, pool, c = st.snaps[s]
        out.append("%6d t / M%4dK / T%4dK (%2d%%)" % (A, M / 10000, T / 10000, round(100 * T / M)))
    return " | ".join(out)


# ----------------------------------------------------------------------------------------------
# Exact grid engine (tile-level mirror of AttackExecution on TerraNullius) - used for --calib/--validate
# ----------------------------------------------------------------------------------------------
class Grid:
    def __init__(self, mixname, size=360, seed=1, spawn_r=4.0):
        self.rng = random.Random(seed)
        self.W = self.H = size
        mix = MIXES[mixname]
        self.terr = bytearray(sample_terrain(self.rng, mix) for _ in range(size * size))
        self.own = bytearray(size * size)
        cx = cy = size // 2
        self.n = 0
        r2 = spawn_r * spawn_r
        for y in range(cy - 6, cy + 7):
            for x in range(cx - 6, cx + 7):
                if (x - (cx - 0.5)) ** 2 + (y - (cy - 0.5)) ** 2 <= r2:
                    self.own[y * size + x] = 1
                    self.n += 1
        self.heap = []
        self.border = set()
        self.pool = 0.0
        self.active = False

    def nbrs(self, t):
        W, H = self.W, self.H
        x, y = t % W, t // W
        if x > 0:
            yield t - 1
        if x < W - 1:
            yield t + 1
        if y > 0:
            yield t - W
        if y < H - 1:
            yield t + W

    def add_neighbors(self, t, tick):
        for nb in self.nbrs(t):
            if self.own[nb] != 0:
                continue
            self.border.add(nb)
            c = 0
            for n2 in self.nbrs(nb):
                if self.own[n2] == 1:
                    c += 1
            mag = (1.0, 1.5, 2.0)[self.terr[nb]]
            pr = (self.rng.randint(0, 6) + 10) * (1 - c * 0.5 + mag / 2) + tick
            heapq.heappush(self.heap, (pr, nb))

    def refresh(self, tick):
        self.heap = []
        self.border = set()
        # owner border tiles: owned tiles with a non-owned neighbour
        for t in range(self.W * self.H):
            pass  # replaced below by scanning bounding box for speed

    def refresh_fast(self, tick, bbox):
        self.heap = []
        self.border = set()
        x0, y0, x1, y1 = bbox
        W = self.W
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                t = y * W + x
                if self.own[t] == 1:
                    for nb in self.nbrs(t):
                        if self.own[nb] == 0:
                            break
                    else:
                        continue
                    self.add_neighbors(t, tick)

    def tick_attack(self, tick):
        if not self.active:
            return 0
        B = len(self.border) + self.rng.randint(0, 4)
        budget = 1.0
        taken = 0
        while budget > 0:
            if self.pool < 1:
                self.pool = 0.0
                self.active = False
                return taken
            if not self.heap:
                return -1  # nothing left -> retreat
            pr, t = heapq.heappop(self.heap)
            self.border.discard(t)
            if self.own[t] != 0:
                continue
            onb = False
            for nb in self.nbrs(t):
                if self.own[nb] == 1:
                    onb = True
                    break
            if not onb:
                continue
            self.add_neighbors(t, tick)
            mag, tc = TERR[self.terr[t]]
            budget -= clamp(2000.0 * tc / self.pool, 5.0, 100.0) / (2.0 * B)
            self.pool -= mag / 5.0
            self.own[t] = 1
            self.n += 1
            taken += 1
        return taken


def run_grid(strat, mixname="mixed", city_t=None, dec=10, seconds=180, seed=1, record_border=False):
    g = Grid(mixname, seed=seed)
    rng = g.rng
    cx = g.W // 2
    st = State()
    st.T, st.pool, st.tick, st.cities = START_T, 0.0, 0, 0
    st.A = g.n
    st.M = max_troops(st.A, 0)
    city_tick = None if city_t is None else int(city_t * TPS)
    pending = None
    snaps = {}
    border_pts = []
    bbox = [cx - 6, cx - 6, cx + 6, cx + 6]
    for tk in range(seconds * TPS + 1):
        st.tick = tk
        if city_tick is not None and tk == city_tick:
            pending = tk + 20
        if pending is not None and tk == pending:
            st.cities += 1
            pending = None
        st.A = g.n
        st.M = max_troops(st.A, st.cities)
        if tk % dec == 0:
            s = min(strat.decide(st), st.T)
            if s >= 1:
                st.T -= s
                g.pool += s
                g.active = True
                g.refresh_fast(tk, bbox)
        if g.active:
            r = g.tick_attack(tk)
            if r == -1:
                st.T += g.pool
                g.pool = 0.0
                g.active = False
            elif r > 0:
                # grow bbox lazily by scanning own extent from border set
                for t in g.border:
                    x, y = t % g.W, t // g.W
                    bbox[0] = min(bbox[0], x - 1)
                    bbox[1] = min(bbox[1], y - 1)
                    bbox[2] = max(bbox[2], x + 1)
                    bbox[3] = max(bbox[3], y + 1)
                bbox[:] = [max(0, bbox[0]), max(0, bbox[1]), min(g.W - 1, bbox[2]), min(g.H - 1, bbox[3])]
            if record_border and g.active:
                border_pts.append((g.n, len(g.border)))
        st.A = g.n
        st.M = max_troops(st.A, st.cities)
        st.T += regen(st.T, st.M)
        if tk % (10 * TPS) == 0 and tk > 0:
            snaps[tk // TPS] = (st.A, st.M, st.T, g.pool, st.cities)
    st.snaps = snaps
    st.border_pts = border_pts
    return st


# ----------------------------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------------------------
def calibrate():
    print("== frontier calibration (grid engine): frontier tiles B vs area A, mixed terrain ==")
    st = run_grid(Floor(0.42), "mixed", seconds=25, record_border=True)
    pts = st.border_pts
    bins = {}
    for A, B in pts:
        k = int(round(math.log(A, 1.5)))
        bins.setdefault(k, []).append((A, B))
    cs = []
    for k in sorted(bins):
        arr = bins[k]
        A = sum(a for a, b in arr) / len(arr)
        B = sum(b for a, b in arr) / len(arr)
        cs.append(B / math.sqrt(A))
        print("  A ~ %6d  B ~ %5.0f   B/sqrt(A) = %.2f" % (A, B, B / math.sqrt(A)))
    if cs:
        print("  mean C = %.2f  (C_BORDER in the fast model = %.2f)" % (sum(cs) / len(cs), C_BORDER))


def validate():
    print("== fast model vs grid engine, 3 strategies x 2 terrains, 90 s (tiles @60/90 s) ==")
    for mix in ("plains", "mixed"):
        for strat in (Floor(0.42), Threshold(0.40, 0.50), Floor(0.60)):
            f = run_fast(strat, mix, seconds=90, seed=3)
            g = run_grid(strat, mix, seconds=90, seed=3)
            print("  %-9s %-18s fast: %6d / %6d   grid: %6d / %6d" % (
                mix, strat.name, f.snaps[60][0], f.snaps[90][0], g.snaps[60][0], g.snaps[90][0]))


def table(title, strats, mixname, **kw):
    print("\n### %s" % title)
    print("| strategy | tiles@60 | tiles@120 | tiles@180 | max@180 (disp) | home@180 (disp, %) | min home % after 30 s | clicks | full at |")
    print("|---|---|---|---|---|---|---|---|---|")
    rows = []
    for s in strats:
        r = run_fast(s, mixname, **kw)
        a60, a120, a180 = r.snaps[60][0], r.snaps[120][0], r.snaps[180][0]
        M, T = r.snaps[180][1], r.snaps[180][2]
        rows.append((a180, s.name, a60, a120, a180, M, T, r))
        print("| %s | %d | %d | %d | %dK | %dK (%d%%) | %d%% | %d | %s |" % (
            s.name, a60, a120, a180, M / 10000, T / 10000, round(100 * T / M), round(100 * r.minfill),
            r.sentclicks, "-" if r.first_full is None else "%ds" % r.first_full))
    return rows


def all_reports(dec=10):
    thr = [Threshold(X / 100, Y / 100) for X in (20, 30, 40, 50, 60) for Y in (10, 20, 30, 50)]
    cont = [Floor(f) for f in (0.20, 0.30, 0.42, 0.50, 0.60)]
    mixed = [FloorDecay(0.30, 0.42), FloorDecay(0.50, 0.30), FloorDecay(0.30, 0.20),
             FloorNoCity(0.42), FloorAbs(60000), FloorAbs(120000)]
    for mix in ("plains", "highland", "mountain", "mixed"):
        for city_t, cn in ((None, "no City"), (125, "City at 125 s (passive gold only)"), (50, "City at 50 s (with Tribe gold)")):
            if mix != "mixed" and city_t == 125:
                continue
            rows = table("%s, open continent, %s, decisions every %.1f s" % (mix, cn, dec / 10),
                         thr + cont + mixed, mix, city_t=city_t, dec=dec)
    # pocket cases: expansion bounded by neighbours
    for cap in (2500, 800):
        table("mixed, POCKET of %d wilderness tiles, no City, decisions %.1f s" % (cap, dec / 10),
              [Threshold(0.40, 0.20), Threshold(0.40, 0.50), Threshold(0.60, 0.30)] + cont + mixed[:2],
              "mixed", land_cap=cap, dec=dec)


def regen_peak(M):
    best = 0.0
    bt = 0.0
    for i in range(1, 1000):
        T = M * i / 1000.0
        g = regen(T, M)
        if g > best:
            best, bt = g, T
    return best, bt / M


def roi():
    print("== regen argmax (numeric) ==")
    for M in (120900, 226000, 602000, 1420000, 2.5e6):
        g, f = regen_peak(M)
        print("  M=%9d raw  peak regen %.0f raw/tick at T/M = %.3f" % (M, g, f))
    print("\n== land payback: one extra tile at A tiles, 0 cities (cost vs regen gained at the new peak) ==")
    print("| tiles A | +max per tile (raw / disp) | peak regen now (disp/s) | +regen per tile (disp/s) | payback plains 16 / highland 20 / mountain 24 (s) |")
    print("|---|---|---|---|---|")
    for A in (50, 300, 1000, 3000, 10000, 30000, 100000):
        M = max_troops(A, 0)
        dM = max_troops(A + 1, 0) - M
        g0, _ = regen_peak(M)
        g1, _ = regen_peak(M + dM)
        dg = (g1 - g0) * TPS  # raw per second
        pb = ["%.0f" % (c / dg) if dg > 0 else "inf" for c in (16, 20, 24)]
        print("| %d | %.0f / %.1f | %.0f | %.2f | %s |" % (A, dM, dM / 10, g0, dg / 10.0, " / ".join(pb)))
    print("\n== first City: +250,000 raw max ==")
    for A in (300, 1000, 3000, 10000):
        M = max_troops(A, 0)
        g0, _ = regen_peak(M)
        g1, _ = regen_peak(M + 250000)
        print("  A=%5d: max %dK -> %dK disp, peak regen %.0f -> %.0f /s (x%.2f), equals %d plains tiles of max"
              % (A, M / 10000, (M + 250000) / 10000, g0, g1, g1 / g0,
                 round((max_troops(A + 1, 0) - M) and 250000 / (max_troops(A + 1, 0) - M))))
    print("\n== wilderness speed (tiles per tick = 2*B / clamp(2000*tileCost/troops,5,100)) ==")
    for name, tc in (("plains", 16.5), ("highland", 20), ("mountain", 25)):
        print("  %-8s saturates at pool >= %d raw (%d disp); at 2500 raw -> %.0f%% of max speed; at 1000 raw -> %.0f%%"
              % (name, 2000 * tc / 5, 2000 * tc / 5 / 10, 100 * 5 / clamp(2000 * tc / 2500, 5, 100), 100 * 5 / clamp(2000 * tc / 1000, 5, 100)))
    print("\n== cost per tile vs a Tribe / Nation / human defender (plains, small attacker; AttackLogic Config.ts:910-958) ==")
    print("| defender | D (troops) | N tiles | send S = k*D | loss/tile (raw) | x wilderness plains(16) | tiles/tick at B=30 |")
    print("|---|---|---|---|---|---|---|")
    for lbl, D, N, atype_bot in (("Tribe 10K start", 10000, 60, True), ("Tribe 30K grown", 30000, 100, True),
                                  ("Nation 60K/200t", 60000, 200, False), ("Human 150K/800t", 150000, 800, False)):
        for k in (0.82, 1.22, 1.67):
            S = k * D
            ratio = D / S
            mag = 80.0 * (0.7 if atype_bot else 1.0)
            loss = mag * clamp(ratio, 0.6, 2.0) * (0.463 + 0.0039 * D / N)
            spd = clamp(ratio, 0.82, 7.5) * clamp(ratio / 20, 1, 50) / 8.55
            tpt = 30.0 / (spd * 16.5)
            print("| %s | %d | %d | %.2fx | %.1f | %.1fx | %.1f |" % (lbl, D, N, k, loss, loss / 16.0, tpt))
    print("  (wilderness at B=30 and pool >= 6600: %.1f tiles/tick)" % (2 * 30 / 5.0))


def sweep(dec=10):
    print("== floor sweep: tiles at horizon vs floor F (open continent, no City) ==")
    Fs = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.42, 0.50, 0.60]
    print("| mix | horizon | " + " | ".join("%d%%" % round(f * 100) for f in Fs) + " | argmax |")
    print("|---|---|" + "---|" * (len(Fs) + 1))
    for mix in ("plains", "highland", "mountain", "mixed"):
        res = {F: run_fast(Floor(F), mix, dec=dec) for F in Fs}
        for h in (60, 120, 180):
            vals = [res[F].snaps[h][0] for F in Fs]
            am = Fs[vals.index(max(vals))]
            print("| %s | %d s | " % (mix, h) + " | ".join("%d" % v for v in vals) + " | %d%% |" % round(am * 100))
    print("\n== decision interval sensitivity (mixed, no City): tiles @60/120/180 ==")
    for d in (10, 20, 30, 50):
        for st in (Floor(0.30), Floor(0.42), Threshold(0.40, 0.20), Threshold(0.30, 0.20), Threshold(0.60, 0.30)):
            r = run_fast(st, "mixed", dec=d)
            print("  every %.0f s  %-14s %6d %6d %6d" % (d / 10, st.name, r.snaps[60][0], r.snaps[120][0], r.snaps[180][0]))
    print("\n== schedules (mixed, no City; City at 50 s) ==")
    for sched in ([(0, 0.20), (60, 0.30), (120, 0.42)], [(0, 0.15), (45, 0.30)], [(0, 0.30), (90, 0.42)],
                  [(0, 0.20), (40, 0.35)], [(0, 0.30)], [(0, 0.25)]):
        for ct in (None, 50):
            r = run_fast(Piecewise(sched), "mixed", dec=dec, city_t=ct)
            print("  %-26s City=%-4s %6d %6d %6d" % (Piecewise(sched).name, ct, r.snaps[60][0], r.snaps[120][0], r.snaps[180][0]))
    print("\n== first 40 s detail (mixed): home troops (disp) and tiles at 10/20/30/40 s, dec=1 s ==")
    for st in (Floor(0.20), Floor(0.30), Floor(0.42), Floor(0.60), Threshold(0.40, 0.20), Threshold(0.60, 0.30)):
        r = run_fast(st, "mixed", dec=10, seconds=40)
        print("  %-14s " % st.name + "  ".join("%ds: %dt/%.1fK" % (t, r.snaps[t][0], r.snaps[t][2] / 10000) for t in (10, 20, 30, 40)))
    print("\n== pocket: time to fill, and home fill at the wall (mixed, no City) ==")
    for cap in (800, 2500, 6000):
        for st in (Floor(0.20), Floor(0.30), Floor(0.42), Floor(0.60), Threshold(0.40, 0.20), Threshold(0.40, 0.50), Threshold(0.60, 0.30)):
            r = run_fast(st, "mixed", dec=dec, land_cap=cap, seconds=90)
            if r.wall:
                w = r.wall
                print("  pocket %5d %-14s wall at %5.1f s  home %dK of %dK (%d%%) + pool %dK" % (
                    cap, st.name, w[0], w[1] / 10000, w[2] / 10000, round(100 * w[1] / w[2]), w[3] / 10000))
            else:
                print("  pocket %5d %-14s not full in 90 s" % (cap, st.name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--calib", action="store_true")
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--roi", action="store_true")
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--dec", type=int, default=10, help="decision interval in ticks (10 = 1 s)")
    ap.add_argument("--one", nargs="*", help="e.g. --one floor 0.42 mixed")
    a = ap.parse_args()
    if a.calib:
        calibrate()
    if a.validate:
        validate()
    if a.roi:
        roi()
    if a.sweep:
        sweep(a.dec)
    if a.all:
        all_reports(a.dec)
    if a.one:
        kind, val, mix = a.one[0], float(a.one[1]), a.one[2]
        s = Floor(val) if kind == "floor" else Threshold(val, float(a.one[3]))
        r = run_fast(s, mix, dec=a.dec)
        print(s.name, fmt(r))
    if not (a.roi or a.sweep or a.all or a.calib or a.validate or a.one):
        ap.print_help()


if __name__ == "__main__":
    main()
