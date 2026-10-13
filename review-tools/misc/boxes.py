"""Tally winners/top-3 inside hand-picked boxes (fractions of map width/height) for the md. python -I boxes.py"""
import math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spawn_analysis as S
games = []
for d in S.load():
    g = S.prep(d)
    if g: games.append(g)
BOX = {  # map key: [(label, x0,x1,y0,y1)]
 "world": [("N Africa + Mediterranean coast", 45, 56, 28, 36), ("Central Africa band", 45, 56, 38, 56), ("Africa all (28-56)", 45, 56, 28, 56), ("N Eurasia (Russia/Kazakhstan)", 62, 72, 8, 20), ("NW North America", 12, 22, 8, 36), ("South America", 26, 36, 50, 62), ("E Asia/Pacific rim", 76, 86, 20, 36)],
 "europe": [("Hungary/Serbia/Balkans N", 60, 68, 55, 66)],
 "gianworldmap": [],
 "giantworldmap": [("N Africa - Sudan band", 44, 58, 30, 45), ("Brazil/Amazon", 28, 36, 48, 58)],
 "scandinavia": [("N Sweden (Norrbotten/Norrland)", 38, 60, 25, 50)],
 "unitedstates": [("Mid-Mississippi/Ohio valley", 56, 66, 36, 64)],
 "balkans": [("Serbia/Vojvodina", 38, 60, 10, 40)],
 "blacksea": [], "britannia": [("Scotland highlands", 40, 58, 18, 40)],
}
for k, boxes in BOX.items():
    gs = [g for g in games if g["k"] == k]
    if not gs: continue
    print(k, "games", len(gs))
    for lab, x0, x1, y0, y1 in boxes:
        sp = w = t3 = 0; ex = ex3 = var = 0.0
        for g in gs:
            for q in g["H"]:
                if x0 <= 100 * q["x"] / g["w"] <= x1 and y0 <= 100 * q["y"] / g["h"] <= y1:
                    p = 1 / len(g["H"]); sp += 1; w += q["grp"] == "W"; t3 += q["grp"] in "WT"; ex += p; var += p * (1 - p)
        print(f"  {lab} ({x0}-{x1}%,{y0}-{y1}%): spawns {sp}, wins {w}, expected {ex:.1f}, z={(w-ex)/math.sqrt(var) if var else 0:+.1f}, top3 {t3}")

# ---- hold-out test: does a map's best region in half A also win more than chance in half B? ----
import collections
def cells(gs, n):
    c = collections.defaultdict(lambda: [0, 0.0, 0.0, 0, 0.0])   # spawns, exp wins, var, wins, top3 count
    for g in gs:
        for q in g["H"]:
            key = (min(n - 1, int(n * q["x"] / g["w"])), min(n - 1, int(n * q["y"] / g["h"])))
            p = 1 / len(g["H"]); v = c[key]; v[0] += 1; v[1] += p; v[2] += p * (1 - p); v[3] += q["grp"] == "W"; v[4] += q["grp"] in "WT"
    return c
for n in (3, 4):
    for MINGAMES in (10, 14):
        tot_w = tot_e = tot_v = 0.0; nm = 0; t3 = 0; e3 = 0.0
        for k in sorted(set(g["k"] for g in games)):
            gs = sorted([g for g in games if g["k"] == k], key=lambda g: g["d"]["start"])
            if len(gs) < MINGAMES: continue
            A, B = gs[0::2], gs[1::2]
            ca, cb = cells(A, n), cells(B, n)
            best = max(ca, key=lambda c_: (ca[c_][3] - ca[c_][1]) if ca[c_][0] >= 8 else -9)
            v = cb.get(best)
            if not v: continue
            tot_w += v[3]; tot_e += v[1]; tot_v += v[2]; nm += 1; t3 += v[4]
            # expected top3 = 3x expected wins
            e3 += 3 * v[1]
            # and the reverse direction
            best = max(cb, key=lambda c_: (cb[c_][3] - cb[c_][1]) if cb[c_][0] >= 8 else -9)
            v = ca.get(best)
            if not v: continue
            tot_w += v[3]; tot_e += v[1]; tot_v += v[2]; nm += 1; t3 += v[4]; e3 += 3 * v[1]
        print(f"hold-out {n}x{n} grid, maps with >={MINGAMES} games: {nm} map-halves; wins in the cell chosen on the OTHER half = {tot_w:.0f}, expected {tot_e:.1f}, z={(tot_w-tot_e)/math.sqrt(tot_v):+.1f}; top3 {t3} vs ~{e3:.0f}")
