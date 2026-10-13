"""Spawn analysis for FFA replays (slim files in tools/replays_slim + map terrain in tools/maps).
Run: python -I spawn_analysis.py            (writes tools/spawn_out.txt too)
Groups: W winner; T finishers ranked 2-3 (finalTiles, then killedAt); O everyone else who lived >=300 s;
X eliminated before 300 s.  Everything is computed from the spawn intent (last click of each player)."""
import json, glob, os, re, math, zlib, statistics as st, collections, sys, io
HERE = os.path.dirname(os.path.abspath(__file__))
key = lambda n: re.sub(r"[^a-z0-9]", "", n.lower())
OUT = io.StringIO()
def P(*a):
    s = " ".join(str(x) for x in a); print(s); OUT.write(s + "\n")

_man, _bin = {}, {}
def manifest(k):
    if k not in _man: _man[k] = json.load(open(os.path.join(HERE, "maps", f"{k}_manifest.json"), encoding="utf-8"))
    return _man[k]
def tbin(k, v):
    if (k, v) not in _bin:
        _bin[(k, v)] = zlib.decompress(open(os.path.join(HERE, "maps", f"{k}_{v}.z"), "rb").read())
    return _bin[(k, v)]

def terrain(b, w, h, x, y):
    """returns dict: shore flag, nearest water (Chebyshev, cap 30), land share of 41x41 window, elevation class"""
    v = b[y * w + x]; mag = v & 31
    cls = "plains" if mag < 10 else ("highland" if mag < 20 else "mountain")
    near = None
    for r in range(1, 31):
        hit = False
        for yy in range(max(0, y - r), min(h, y + r + 1)):
            edge = (yy == y - r or yy == y + r)
            xs = range(max(0, x - r), min(w, x + r + 1)) if edge else [xx for xx in (x - r, x + r) if 0 <= xx < w]
            for xx in xs:
                if not (b[yy * w + xx] & 128): hit = True; break
            if hit: break
        if hit: near = r; break
    land = tot = 0
    for yy in range(max(0, y - 20), min(h, y + 21)):
        row = yy * w
        for xx in range(max(0, x - 20), min(w, x + 21)):
            tot += 1; land += b[row + xx] >> 7
    return dict(shore=bool(v & 64), water=near if near else 31, land41=land / tot, cls=cls, mag=mag)

def load():
    G = []
    for f in sorted(glob.glob(os.path.join(HERE, "replays_slim", "c*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        if d["mode"] != "Free For All" or d.get("teams") or not d.get("winner") or d["winner"][0] != "player": continue
        if (d.get("cfg") or {}).get("randomSpawn") or (d.get("cfg") or {}).get("nations") == "disabled": continue   # spawn not chosen / no Nations
        G.append(d)
    return G

def prep(d):
    """return per-game dict or None"""
    k = key(d["map"]); v = "map4x" if d["size"] == "Compact" else "map"
    if not os.path.exists(os.path.join(HERE, "maps", f"{k}_{v}.z")) or not os.path.exists(os.path.join(HERE, "maps", f"{k}_manifest.json")): return None
    man = manifest(k); mm = man[v]; w, h = mm["width"], mm["height"]
    scale = 1 if v == "map" else 2          # grid units -> Normal-map units
    sp = collections.defaultdict(list)
    for turn, tile, cid in d["spawns"]: sp[cid].append((turn, tile))
    pl = {p["cid"]: p for p in d["players"]}
    H = []
    for cid, lst in sp.items():
        if cid not in pl: continue
        lst.sort(); t = lst[-1][1]
        H.append(dict(cid=cid, x=t % w, y=t // w, t0=lst[0][0] / 10, t1=lst[-1][0] / 10, clicks=len(lst), p=pl[cid]))
    if len(H) < 8: return None
    wcid = d["winner"][1]
    if wcid not in sp: return None
    # ranks: survivors by finalTiles, dead by killedAt (later = better)
    def sk(q):
        p = q["p"]; ka = p["killedAt"]
        return (p["finalTiles"], int(ka) if ka else 10**9 if p["finalTiles"] > 0 else 0)
    order = sorted(H, key=lambda q: (q["cid"] == wcid, sk(q)), reverse=True)
    for i, q in enumerate(order):
        q["rank"] = i + 1
        ka = q["p"]["killedAt"]; life = (int(ka) / 10) if ka else d["duration"]
        q["life"] = life
        q["grp"] = "W" if q["cid"] == wcid else ("T" if i in (1, 2) else ("X" if life < 300 else "O"))
    nat = [(c[0] / (1 if v == "map" else 2), c[1] / (1 if v == "map" else 2), n.get("name")) for n in man.get("nations", []) if "coordinates" in n for c in [n["coordinates"]]]
    b = tbin(k, v); land = mm["num_land_tiles"]
    N = len(H) + len(man.get("nations", []))      # coordinate-less Nations still take space (spawn randomly)
    unit = math.sqrt(land / N)               # typical spacing between spawns if evenly spread
    return dict(d=d, k=k, v=v, w=w, h=h, scale=scale, H=H, nat=nat, b=b, land=land, N=N, unit=unit, wcid=wcid)

def metrics(g):
    H, nat, w, h, b = g["H"], g["nat"], g["w"], g["h"], g["b"]
    pts = [(q["x"], q["y"], "h", q["cid"]) for q in H] + [(x, y, "n", nm) for x, y, nm in nat]
    # Voronoi share of land on a coarse grid (Euclidean, ignores water paths)
    step = max(1, int(math.sqrt(g["land"] / 5000)))
    cnt = collections.Counter(); tot = 0; sx = sy = 0
    for y in range(step // 2, h, step):
        row = y * w
        for x in range(step // 2, w, step):
            if not (b[row + x] & 128): continue
            best = None; bd = 1e18
            for px, py, kind, ident in pts:
                dd = (px - x) ** 2 + (py - y) ** 2
                if dd < bd: bd = dd; best = ident if kind == "h" else None
            tot += 1; sx += x; sy += y
            if best is not None: cnt[best] += 1
    fair = 1.0 / g["N"]; cx, cy = sx / tot, sy / tot
    for q in H:
        o = [r for r in H if r is not q];
        dh = [math.hypot(q["x"] - r["x"], q["y"] - r["y"]) for r in o]
        dn = [math.hypot(q["x"] - x, q["y"] - y) for x, y, _ in nat]
        q["dh"] = min(dh); q["dn"] = min(dn) if dn else float("nan")
        q["dall"] = min(q["dh"], q["dn"] if dn else 1e9)
        q["dh_n"] = q["dh"] / g["unit"]; q["dn_n"] = q["dn"] / g["unit"]; q["dall_n"] = q["dall"] / g["unit"]
        for R in (50, 100):
            q[f"h{R}"] = sum(1 for z in dh if z <= R); q[f"n{R}"] = sum(1 for z in dn if z <= R)
        q["dcen"] = math.hypot(q["x"] - cx, q["y"] - cy) / math.sqrt(g["land"])      # distance from land centroid, in sqrt(land) units
        q["vor"] = (cnt[q["cid"]] / tot) / fair if tot else float("nan")      # 1.0 = fair share
        q.update(terrain(b, w, h, q["x"], q["y"]))
    # spawn order among humans (first click and last click), as percentile 0=earliest
    for key_, nm in (("t0", "ord0"), ("t1", "ord1")):
        vs = sorted(r[key_] for r in H)
        for q in H:
            lo = sum(1 for z in vs if z < q[key_]); eq = sum(1 for z in vs if z == q[key_])
            q[nm] = (lo + 0.5 * eq) / len(vs)
    tmin = min(r["t0"] for r in H)
    for q in H: q["rt0"] = q["t0"] - tmin; q["rt1"] = q["t1"] - tmin
    return cnt

def pct_in_game(H, m):
    vs = [r[m] for r in H if not (isinstance(r[m], float) and math.isnan(r[m]))]
    for q in H:
        if isinstance(q[m], float) and math.isnan(q[m]): q["pc_" + m] = None; continue
        lo = sum(1 for z in vs if z < q[m]); eq = sum(1 for z in vs if z == q[m])
        q["pc_" + m] = (lo + 0.5 * eq) / len(vs)

def q3(xs):
    xs = sorted(xs)
    if len(xs) < 4: return (None,) * 3
    c = st.quantiles(xs, n=4, method="inclusive"); return c[0], c[1], c[2]
def fm(x, nd=1): return "-" if x is None else f"{x:.{nd}f}"

def main():
    games = []
    for d in load():
        g = prep(d)
        if g: metrics(g); games.append(g)
    P(f"games used: {len(games)}  maps: {len(set(g['k'] for g in games))}  human spawns: {sum(len(g['H']) for g in games)}")
    P("games by size:", dict(collections.Counter(g['v'] for g in games)), " median humans/game:", st.median(len(g['H']) for g in games),
      " median nations/game:", st.median(len(g['nat']) for g in games))
    R = {grp: [] for grp in "WTOX"}
    for g in games:
        for q in g["H"]: R[q["grp"]].append((g, q))
    P("group n:", {k: len(v) for k, v in R.items()})
    METS = ["dh", "dn", "dall", "dh_n", "dn_n", "dall_n", "h50", "h100", "n50", "n100", "vor", "dcen", "water", "land41", "rt0", "rt1", "ord0", "ord1", "clicks"]
    for g in games:
        for m in METS: pct_in_game(g["H"], m)
    LAB = dict(dh="nearest other human spawn (grid tiles)", dn="nearest Nation spawn (grid tiles)", dall="nearest of either (grid tiles)",
               dh_n="nearest human, in units of fair spacing", dn_n="nearest Nation, fair-spacing units", dall_n="nearest either, fair-spacing units",
               h50="humans within 50 tiles", h100="humans within 100 tiles", n50="Nations within 50", n100="Nations within 100",
               vor="Voronoi land share / fair share (1=fair)", dcen="distance from land centroid / sqrt(land)", water="tiles to nearest water (cap 31)", land41="land share in 41x41 window",
               rt0="first spawn click, s after the earliest click", rt1="last (final) spawn click, s after earliest", ord0="first-click order pct (0 earliest)",
               ord1="final-click order pct", clicks="spawn clicks per player")
    P("\n## A. medians (Q1-Q3) by group")
    P("metric | " + " | ".join(f"{k} (n={len(R[k])})" for k in "WTOX"))
    for m in METS:
        row = []
        for grp in "WTOX":
            xs = [q[m] for _, q in R[grp] if not (isinstance(q[m], float) and math.isnan(q[m]))]
            a, b_, c = q3(xs); row.append(f"{fm(b_, 2 if m in ('vor','land41','dh_n','dn_n','dall_n','ord0','ord1','dcen') else 1)} ({fm(a,2 if m in ('vor','land41','dh_n','dn_n','dall_n','ord0','ord1','dcen') else 1)}-{fm(c,2 if m in ('vor','land41','dh_n','dn_n','dall_n','ord0','ord1','dcen') else 1)})")
        P(LAB[m] + " | " + " | ".join(row))
    P("\n## B. within-game percentile (0=lowest in game, 0.5=typical); mean +- 95% CI; no effect = 0.50")
    P("metric | " + " | ".join(grp for grp in "WTOX"))
    for m in METS:
        row = []
        for grp in "WTOX":
            xs = [q["pc_" + m] for _, q in R[grp] if q["pc_" + m] is not None]
            if len(xs) < 5: row.append("-"); continue
            mu = st.mean(xs); se = st.pstdev(xs) / math.sqrt(len(xs)); row.append(f"{mu:.2f} +-{1.96*se:.2f}")
        P(LAB[m] + " | " + " | ".join(row))
    P("\nshare of players with >=1 OTHER spawn within the radius (game-grid tiles)")
    P("what | " + " | ".join(grp for grp in "WTOX") + " | all")
    for nm, f in [("human within 50", lambda q: q["h50"] >= 1), ("human within 100", lambda q: q["h100"] >= 1), ("2+ humans within 100", lambda q: q["h100"] >= 2),
                  ("Nation within 50", lambda q: q["n50"] >= 1), ("Nation within 100", lambda q: q["n100"] >= 1), ("any spawn within 50", lambda q: q["h50"] + q["n50"] >= 1), ("any spawn within 100", lambda q: q["h100"] + q["n100"] >= 1)]:
        xs = {grp: [f(q) for _, q in R[grp]] for grp in "WTOX"}; al = sum(xs.values(), [])
        P(nm + " | " + " | ".join(f"{100*sum(xs[k])/len(xs[k]):.0f}%" for k in "WTOX") + f" | {100*sum(al)/len(al):.0f}%")
    # terrain
    P("\n## C. terrain at spawn (share of players)")
    P("feature | " + " | ".join(f"{k}" for k in "WTOX") + " | all")
    def share(f, grp=None):
        xs = [f(q) for g, q in (R[grp] if grp else sum(R.values(), []))]
        return f"{100*sum(xs)/len(xs):.0f}%"
    FE = [("on shoreline tile", lambda q: q["shore"]), ("water within 5 tiles", lambda q: q["water"] <= 5), ("water within 15", lambda q: q["water"] <= 15),
          ("inland (no water within 30)", lambda q: q["water"] >= 31), ("plains", lambda q: q["cls"] == "plains"), ("highland", lambda q: q["cls"] == "highland"),
          ("mountain", lambda q: q["cls"] == "mountain"), ("land share <60% in 41x41 (peninsula/isle/coast)", lambda q: q["land41"] < 0.6)]
    for nm, f in FE: P(nm + " | " + " | ".join(share(f, grp) for grp in "WTOX") + " | " + share(f))
    # win rate by terrain / distance bucket (pooled; baseline = mean 1/humans)
    P("\n## D. winners per spawn by bucket (win share vs expected if spawn didn't matter)")
    def bucket(name, f, labels):
        P(name)
        for lab in labels:
            s = [(g, q) for g, q in sum(R.values(), []) if f(q) == lab]
            if not s: continue
            wins = sum(1 for g, q in s if q["grp"] == "W"); exp = sum(1 / len(g["H"]) for g, q in s)
            top3 = sum(1 for g, q in s if q["grp"] in "WT"); exp3 = sum(3 / len(g["H"]) for g, q in s)
            v1 = sum(1 / len(g["H"]) * (1 - 1 / len(g["H"])) for g, q in s); v3 = sum(min(1, 3 / len(g["H"])) * (1 - min(1, 3 / len(g["H"]))) for g, q in s)
            z1 = (wins - exp) / math.sqrt(v1) if v1 else 0; z3 = (top3 - exp3) / math.sqrt(v3) if v3 else 0
            P(f"  {lab}: n={len(s)}  wins={wins} expected={exp:.1f} ratio={wins/exp:.2f} z={z1:+.1f} | top3={top3} expected={exp3:.1f} ratio={top3/exp3:.2f} z={z3:+.1f}")
    bucket("nearest human spawn, fair-spacing units", lambda q: "<0.25" if q["dh_n"] < .25 else "0.25-0.5" if q["dh_n"] < .5 else "0.5-0.9" if q["dh_n"] < .9 else ">=0.9", ["<0.25", "0.25-0.5", "0.5-0.9", ">=0.9"])
    bucket("nearest Nation spawn, fair-spacing units", lambda q: "<0.3" if q["dn_n"] < .3 else "0.3-0.6" if q["dn_n"] < .6 else "0.6-1" if q["dn_n"] < 1 else ">=1", ["<0.3", "0.3-0.6", "0.6-1", ">=1"])
    bucket("Voronoi land share vs fair", lambda q: "<0.5" if q["vor"] < .5 else "0.5-1" if q["vor"] < 1 else "1-1.5" if q["vor"] < 1.5 else ">=1.5", ["<0.5", "0.5-1", "1-1.5", ">=1.5"])
    bucket("distance from the land centroid (within-game quartile, 1=most central)", lambda q: "Q1 most central" if q["pc_dcen"] < .25 else "Q2" if q["pc_dcen"] < .5 else "Q3" if q["pc_dcen"] < .75 else "Q4 most peripheral", ["Q1 most central", "Q2", "Q3", "Q4 most peripheral"])
    bucket("humans within 100 grid tiles", lambda q: "0" if q["h100"] == 0 else "1" if q["h100"] == 1 else "2+", ["0", "1", "2+"])
    bucket("humans within 50 grid tiles", lambda q: "0" if q["h50"] == 0 else "1+", ["0", "1+"])
    bucket("Nations within 50 grid tiles", lambda q: "0" if q["n50"] == 0 else "1+", ["0", "1+"])
    bucket("terrain", lambda q: q["cls"], ["plains", "highland", "mountain"])
    bucket("water distance", lambda q: "shore" if q["shore"] else "<=5" if q["water"] <= 5 else "6-15" if q["water"] <= 15 else "16-30" if q["water"] <= 30 else "inland", ["shore", "<=5", "6-15", "16-30", "inland"])
    bucket("final click order (human)", lambda q: "first quarter" if q["ord1"] < .25 else "2nd" if q["ord1"] < .5 else "3rd" if q["ord1"] < .75 else "last quarter", ["first quarter", "2nd", "3rd", "last quarter"])
    bucket("seconds between earliest click and own final click", lambda q: "<5" if q["rt1"] < 5 else "5-10" if q["rt1"] < 10 else "10-20" if q["rt1"] < 20 else ">=20", ["<5", "5-10", "10-20", ">=20"])
    bucket("clicks", lambda q: "1" if q["clicks"] == 1 else "2" if q["clicks"] == 2 else "3+", ["1", "2", "3+"])
    # timing distribution
    allq = [q for g in games for q in g["H"]]
    P("\nspawn timing (all humans): final click s after earliest: median %.1f Q1-Q3 %s; share who clicked more than once %.0f%%"
      % (st.median(q["rt1"] for q in allq), "-".join(fm(x) for x in (q3([q["rt1"] for q in allq])[0], q3([q["rt1"] for q in allq])[2])), 100 * sum(q["clicks"] > 1 for q in allq) / len(allq)))
    P("spawn window: median of latest final click per game (s after earliest): %.1f" % st.median(max(q["rt1"] for q in g["H"]) for g in games))
    # per map regions
    P("\n## E. winner spawn regions per map")
    bymap = collections.defaultdict(list)
    for g in games: bymap[g["k"]].append(g)
    names = {g["k"]: g["d"]["map"] for g in games}
    ranked = sorted(bymap.items(), key=lambda kv: -len(kv[1]))
    P("maps by games:", ", ".join(f"{names[k]}:{len(v)}" for k, v in ranked[:25]))
    for k, gs in ranked:
        if len(gs) < 5: break
        P(f"\n{names[k]}  n={len(gs)} games (sizes: {dict(collections.Counter(g['v'] for g in gs))}; humans median {st.median(len(g['H']) for g in gs)})")
        cells = collections.defaultdict(lambda: [0, 0, 0, 0.0])      # [spawns, wins, top3, expected wins]
        for g in gs:
            for q in g["H"]:
                cx = min(2, int(3 * q["x"] / g["w"])); cy = min(2, int(3 * q["y"] / g["h"]))
                c = cells[(cy, cx)]; c[0] += 1; c[1] += q["grp"] == "W"; c[2] += q["grp"] in "WT"; c[3] += 1 / len(g["H"])
        nm = [["NW", "N", "NE"], ["W", "C", "E"], ["SW", "S", "SE"]]
        P("  3x3 cells (spawns / wins / expected wins): " + "; ".join(f"{nm[cy][cx]} {c[0]}/{c[1]}/{c[3]:.1f}" for (cy, cx), c in sorted(cells.items())))
        reg = collections.defaultdict(lambda: [0, 0, 0, 0.0])           # region = nearest placed Nation
        for g in gs:
            if not g["nat"]: continue
            for q in g["H"]:
                nr = min(g["nat"], key=lambda t: (t[0] - q["x"]) ** 2 + (t[1] - q["y"]) ** 2)[2]
                c = reg[nr]; c[0] += 1; c[1] += q["grp"] == "W"; c[2] += q["grp"] in "WT"; c[3] += 1 / len(g["H"])
        hot = sorted([(r, c) for r, c in reg.items() if c[1] >= 2], key=lambda rc: -rc[1][1])
        P("  regions (nearest Nation) with >=2 wins: " + ("; ".join(f"{r} spawns {c[0]} wins {c[1]} (expected {c[3]:.1f}) top3 {c[2]}" for r, c in hot[:8]) or "none"))
        for g in gs:
            q = next(r for r in g["H"] if r["grp"] == "W")
            near = min(g["nat"], key=lambda t: (t[0] - q["x"]) ** 2 + (t[1] - q["y"]) ** 2) if g["nat"] else None
            nn = f"{near[2]} @{math.hypot(near[0]-q['x'], near[1]-q['y']):.0f}t" if near else "-"
            P(f"  {g['d']['gameID']} {len(g['H'])}p  winner spawn ({100*q['x']/g['w']:.0f}%,{100*q['y']/g['h']:.0f}%) {g['v']} nearest-nation {nn} nearest-human {q['dh']:.0f}t water {q['water']} {q['cls']} vor {q['vor']:.1f} click {q['rt1']:.0f}s")
    open(os.path.join(HERE, "spawn_out.txt"), "w", encoding="utf-8").write(OUT.getvalue())
if __name__ == "__main__": main()
