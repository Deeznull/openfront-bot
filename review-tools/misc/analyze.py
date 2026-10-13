"""Winners vs top-3 vs rest, from cached OpenFront FFA replays.
Run: python -I analyze.py > out.txt   (fetch.py downloads the replays into tools/replays first)
Groups: W = winner, T = rank 2-3 (survivors by final tiles, then latest killedAt),
        O = everybody else who lasted >= 300 s (keeps phase comparisons fair)."""
import sys, os, statistics as st, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load import load_games

MINP = int(sys.argv[1]) if len(sys.argv) > 1 else 5      # min active players per game (arg: 30 for big-lobby sensitivity)
G = [g for g in load_games() if g["nact"] >= MINP]          # drops degenerate games (everyone left)
GROUPS = ("W", "T", "O")
PH = [(0, 120), (120, 300), (300, 600), (600, 1e9)]
PHN = ["0-2m", "2-5m", "5-10m", "10m+"]


def q(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return "n=0"
    n = len(xs)
    f = lambda p: xs[min(n - 1, int(p * n))]
    return f"{st.median(xs):.3g} [{f(.25):.3g}-{f(.75):.3g}] n={n}"


def row(label, d, fmt=q):
    print(f"| {label} | " + " | ".join(fmt(d[g]) for g in GROUPS) + " |")


def share(xs):
    return f"{sum(xs) / max(1, len(xs)):.2f} n={len(xs)}"


def head(title):
    print(f"\n### {title}\n| metric | W (winner) | T (rank 2-3) | O (rest, alive>=5min) |\n|---|---|---|---|")


def members(g):
    for p in g["players"]:
        if p["group"] == "O" and p["end"] < 300:
            continue
        yield p


PL = {x: [] for x in GROUPS}
for g in G:
    for p in members(g):
        p["g"] = g
        PL[p["group"]].append(p)
ALL = sum(PL.values(), [])

print(f"games={len(G)} players W={len(PL['W'])} T={len(PL['T'])} O={len(PL['O'])}")
print("dur median/min/max", st.median(g['dur'] for g in G), min(g['dur'] for g in G), max(g['dur'] for g in G))
print("players per game median", st.median(g['nact'] for g in G), " win_share median", round(st.median(g['win_share'] for g in G), 3),
      "min", round(min(g['win_share'] for g in G), 3), "survivors median", st.median(g['survivors'] for g in G))
print("start range ms", min(g['start'] for g in G), max(g['start'] for g in G))


def overlap(p, a, b):
    return max(0, min(b, p["end"]) - max(a, p["beg"]))


def bursts(p, gap=3.0):
    """merge consecutive attack clicks on the same target within gap s into one engagement"""
    out = []
    last = None
    for a in p["attacks"]:
        if last and a[3] == last[3] and a[0] - last[0] <= gap:
            out[-1].append(a)
        else:
            out.append([a])
        last = a
    return out


for p in ALL:
    p["bursts"] = bursts(p)

# ---------- (a) attack frequency
head("Attack CLICKS per alive minute (phase; clock starts when spawn phase ends)")
for i, (a, b) in enumerate(PH):
    row(PHN[i], {gr: [sum(1 for x in p["attacks"] if a <= x[0] < b) / (overlap(p, a, b) / 60) for p in PL[gr] if overlap(p, a, b) >= 30] for gr in GROUPS})
head("Attack ENGAGEMENTS (click bursts on one target within 3 s) per alive minute")
for i, (a, b) in enumerate(PH):
    row(PHN[i], {gr: [sum(1 for x in p["bursts"] if a <= x[0][0] < b) / (overlap(p, a, b) / 60) for p in PL[gr] if overlap(p, a, b) >= 30] for gr in GROUPS})
head("Clicks per engagement (mean per player)")
for i, (a, b) in enumerate(PH):
    row(PHN[i], {gr: [st.mean(len(x) for x in p["bursts"] if a <= x[0][0] < b) for p in PL[gr] if any(a <= x[0][0] < b for x in p["bursts"])] for gr in GROUPS})
head("Attack clicks in first N s of game clock")
for T in (30, 60, 120, 180):
    row(f"first {T} s", {gr: [sum(1 for x in p["attacks"] if x[0] < T) for p in PL[gr]] for gr in GROUPS})
head("Attack size (troops sent), median per player")
for i, (a, b) in enumerate(PH):
    row(PHN[i] + " abs", {gr: [st.median(x[1] for x in p["attacks"] if a <= x[0] < b) for p in PL[gr] if any(a <= x[0] < b for x in p["attacks"])] for gr in GROUPS})
for i, (a, b) in enumerate(PH):
    row(PHN[i] + " / peakTroops", {gr: [st.median(x[1] for x in p["attacks"] if a <= x[0] < b) / p["peak"] for p in PL[gr] if p["peak"] and any(a <= x[0] < b for x in p["attacks"])] for gr in GROUPS})
head("First wilderness attack and spawn")
row("time of first wilderness attack", {gr: [next((x[0] for x in p["attacks"] if x[2] == "wild"), None) for p in PL[gr]] for gr in GROUPS})
row("troops of first wilderness attack", {gr: [next((x[1] for x in p["attacks"] if x[2] == "wild"), None) for p in PL[gr]] for gr in GROUPS})
row("last spawn click (s)", {gr: [p["t_spawn"] for p in PL[gr]] for gr in GROUPS})
row("spawn clicks", {gr: [len(p["spawn"]) for p in PL[gr]] for gr in GROUPS})
print("\n### Successive-click size ratio within one engagement (clicks 0.09-3 s apart; ~0.8 means ~20% slider)")
for gr in GROUPS:
    allr = []
    for p in PL[gr]:
        for b in p["bursts"]:
            for x, y in zip(b, b[1:]):
                if x[1] > 0 and 0.09 <= y[0] - x[0] <= 3:
                    allr.append(y[1] / x[1])
    inb = sum(1 for v in allr if 0.7 <= v <= 0.85)
    print(f"{gr}: ratios {q(allr)}; share in 0.70-0.85 = {inb / max(1, len(allr)):.2f}")
head("Churn")
row("sum attack troops / peakTroops", {gr: [sum(x[1] for x in p["attacks"]) / p["peak"] for p in PL[gr] if p["peak"]] for gr in GROUPS})
row("attack clicks total", {gr: [len(p["attacks"]) for p in PL[gr]] for gr in GROUPS})
row("attack clicks per alive min (whole game)", {gr: [len(p["attacks"]) / max(1, (p["end"] - p["beg"]) / 60) for p in PL[gr]] for gr in GROUPS})
row("cancel_attack per game", {gr: [p["cancel"] for p in PL[gr]] for gr in GROUPS})

head("Attack duty cycle: share of 30-s windows with >=1 attack click (alive part of phase)")
for i, (a, b) in enumerate(PH):
    def duty(p, a=a, b=b):
        lo = max(a, p["beg"]); hi = min(b, p["end"], p["g"]["dur"])
        if hi - lo < 60: return None
        ws = int((hi - lo) // 30)
        hit = {int((x[0] - lo) // 30) for x in p["attacks"] if lo <= x[0] < hi}
        return len([h for h in hit if h < ws]) / ws
    row(PHN[i], {gr: [duty(p) for p in PL[gr]] for gr in GROUPS})
def maxgap(p, a, b):
    ts = [p["beg"] if p["beg"] > a else a] + [x[0] for x in p["attacks"] if a <= x[0] < min(b, p["end"])] + [min(b, p["end"])]
    return max(y - x for x, y in zip(ts, ts[1:]))
row("longest attack-free gap in 5-10 min (s)", {gr: [maxgap(p, 300, 600) for p in PL[gr] if p["end"] >= 600] for gr in GROUPS})
row("first wilderness click exactly 5000 troops (default 20% of 25000)", {gr: [1 if next((x[1] for x in p["attacks"] if x[2] == "wild"), 0) == 5000 else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)

# ---------- (b) targets
TC = ["wild", "bot", "nation", "human"]
print("\n### Targets: share of attack CLICKS and of TROOPS sent by target class, per phase (pooled)")
print("| group | phase | clicks: wild | bot(tribe) | nation | human | troops: wild | bot | nation | human | n clicks |\n|---|---|---|---|---|---|---|---|---|---|---|")
for gr in GROUPS:
    for i, (a, b) in enumerate(PH):
        c = collections.Counter()
        t = collections.Counter()
        for p in PL[gr]:
            for x in p["attacks"]:
                if a <= x[0] < b:
                    c[x[2]] += 1
                    t[x[2]] += x[1]
        N = sum(c.values()) or 1
        T = sum(t.values()) or 1
        print(f"| {gr} | {PHN[i]} | " + " | ".join(f"{c[k] / N:.2f}" for k in TC) + " | " + " | ".join(f"{t[k] / T:.2f}" for k in TC) + f" | {N} |")
head("Time of first attack on class (s)")
for k in ("bot", "nation", "human"):
    row(f"first on {k}", {gr: [next((x[0] for x in p["attacks"] if x[2] == k), None) for p in PL[gr]] for gr in GROUPS})
head("Share of players who attacked class before 300 s")
for k in ("bot", "nation", "human"):
    row(f"{k} <300s", {gr: [1 if any(x[2] == k and x[0] < 300 for x in p["attacks"]) else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
head("Distinct targets attacked")
for k in ("human", "nation", "bot"):
    row(f"distinct {k}", {gr: [len({x[3] for x in p["attacks"] if x[2] == k}) for p in PL[gr]] for gr in GROUPS})
head("Eliminations of humans (stats.kills)")
kills = lambda p: sorted(int(k["tick"]) / 10 for k in (p["stats"].get("kills") or []))
row("human kills", {gr: [len(kills(p)) for p in PL[gr]] for gr in GROUPS})
row("first human kill (s)", {gr: [kills(p)[0] if kills(p) else None for p in PL[gr]] for gr in GROUPS})

# ---------- (c) boats
head("Boats (boat intents)")
row("first boat (s)", {gr: [p["boats"][0][0] if p["boats"] else None for p in PL[gr]] for gr in GROUPS})
row("boats by 300 s", {gr: [sum(1 for b in p["boats"] if b[0] < 300) for p in PL[gr]] for gr in GROUPS})
row("boats by 120 s", {gr: [sum(1 for b in p["boats"] if b[0] < 120) for p in PL[gr]] for gr in GROUPS})
row("boats total", {gr: [len(p["boats"]) for p in PL[gr]] for gr in GROUPS})
row("boats per alive min", {gr: [len(p["boats"]) / max(1, (p["end"] - p["beg"]) / 60) for p in PL[gr]] for gr in GROUPS})
row("share with >=1 boat by 120 s", {gr: [1 if any(b[0] < 120 for b in p["boats"]) else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
row("first boat troops", {gr: [p["boats"][0][1] if p["boats"] else None for p in PL[gr]] for gr in GROUPS})


def boat_rel(p):
    r = []
    for t, tr in p["boats"]:
        near = [x[1] for x in p["attacks"] if abs(x[0] - t) <= 60]
        if near:
            r.append(tr / st.median(near))
    return st.median(r) if r else None


row("median boat size / median land attack within +-60 s", {gr: [boat_rel(p) for p in PL[gr]] for gr in GROUPS})
row("median boat size / peakTroops", {gr: [st.median(b[1] for b in p["boats"]) / p["peak"] for p in PL[gr] if p["boats"] and p["peak"]] for gr in GROUPS})
row("boats / (boats+attack clicks)", {gr: [len(p["boats"]) / max(1, len(p["boats"]) + len(p["attacks"])) for p in PL[gr]] for gr in GROUPS})

# ---------- (d) economy
UNITS = ["City", "Port", "Factory", "Defense Post", "Missile Silo", "SAM Launcher", "Warship"]
names = collections.Counter(b[1] for g in G for p in g["players"] for b in p["builds"])
print("\nbuild unit names:", dict(names))
head("First build time (s) per type (among players who built it)")
for u in UNITS:
    row(u, {gr: [next((b[0] for b in p["builds"] if b[1] == u), None) for p in PL[gr]] for gr in GROUPS})
head("Share with >=1 by 300 s / by 600 s (of those alive at 600 s)")
for u in UNITS:
    print(f"| {u} | " + " | ".join(
        f"{sum(1 for p in PL[gr] if any(b[1] == u and b[0] < 300 for b in p['builds'])) / len(PL[gr]):.2f} / "
        f"{sum(1 for p in PL[gr] if p['end'] >= 600 and any(b[1] == u and b[0] < 600 for b in p['builds'])) / max(1, sum(1 for p in PL[gr] if p['end'] >= 600)):.2f}"
        for gr in GROUPS) + " |")
head("Structures built by time (players alive then)")
S = {"City", "Port", "Factory", "Defense Post", "Missile Silo", "SAM Launcher"}
for T in (300, 600, 900):
    row(f"all structures by {T}s", {gr: [sum(1 for b in p["builds"] if b[0] < T and b[1] in S) for p in PL[gr] if p["end"] >= T] for gr in GROUPS})
for u in ("City", "Port", "Factory"):
    for T in (300, 600):
        row(f"{u} by {T}s", {gr: [sum(1 for b in p["builds"] if b[0] < T and b[1] == u) for p in PL[gr] if p["end"] >= T] for gr in GROUPS})
head("Upgrades (upgrade_structure)")
for T in (300, 600, 900):
    row(f"upgrades by {T}s", {gr: [sum(1 for b in p["upgrades"] if b[0] < T) for p in PL[gr] if p["end"] >= T] for gr in GROUPS})
row("first upgrade (s)", {gr: [p["upgrades"][0][0] if p["upgrades"] else None for p in PL[gr]] for gr in GROUPS})
row("share who ever upgrade", {gr: [1 if p["upgrades"] else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
row("build_unit per alive min", {gr: [len(p["builds"]) / max(1, (p["end"] - p["beg"]) / 60) for p in PL[gr]] for gr in GROUPS})
head("Nukes etc. (build_unit)")
for u in sorted(names):
    if u in UNITS or u in ("Train", "TransportShip", "Shell", "Trade"):
        continue
    row(u + " built", {gr: [sum(1 for b in p["builds"] if b[1] == u) for p in PL[gr]] for gr in GROUPS})
    row(u + " first (s)", {gr: [next((b[0] for b in p["builds"] if b[1] == u), None) for p in PL[gr]] for gr in GROUPS})

# ---------- (f) stats: troops/gold
head("Stats: peakTroops, gold, final tiles")
row("peakTroops (K)", {gr: [p["peak"] / 1e3 for p in PL[gr]] for gr in GROUPS})
row("gold total (M, sum stats.gold)", {gr: [sum(int(v) for v in p["stats"].get("gold", [0])) / 1e6 for p in PL[gr]] for gr in GROUPS})
for k in range(4):
    row(f"gold[{k}] (M)", {gr: [(int(p["stats"]["gold"][k]) if len(p["stats"].get("gold", [])) > k else 0) / 1e6 for p in PL[gr]] for gr in GROUPS})
row("final tiles (K)", {gr: [p["final_tiles"] / 1e3 for p in PL[gr]] for gr in GROUPS})

# ---------- (e) alliances
head("Alliances")
for i, (a, b) in enumerate(PH):
    row(f"requests sent {PHN[i]}", {gr: [sum(1 for r in p["req"] if a <= r[0] < b) for p in PL[gr] if overlap(p, a, b) >= 30] for gr in GROUPS})
row("requests total", {gr: [len(p["req"]) for p in PL[gr]] for gr in GROUPS})
row("requests to humans", {gr: [sum(1 for r in p["req"] if r[2] == "human") for p in PL[gr]] for gr in GROUPS})
row("requests to nations", {gr: [sum(1 for r in p["req"] if r[2] == "nation") for p in PL[gr]] for gr in GROUPS})
row("first request (s)", {gr: [p["req"][0][0] if p["req"] else None for p in PL[gr]] for gr in GROUPS})
row("extensions total", {gr: [len(p["ext"]) for p in PL[gr]] for gr in GROUPS})
row("breaks total", {gr: [len(p["brk"]) for p in PL[gr]] for gr in GROUPS})
row("share who ever break", {gr: [1 if p["brk"] else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
row("breaks on humans", {gr: [sum(1 for r in p["brk"] if r[2] == "human") for p in PL[gr]] for gr in GROUPS})
row("time of first break (s)", {gr: [p["brk"][0][0] if p["brk"] else None for p in PL[gr]] for gr in GROUPS})
row("break time / game length", {gr: [r[0] / p["g"]["dur"] for p in PL[gr] for r in p["brk"]] for gr in GROUPS})
row("rejects sent", {gr: [p["rej"] for p in PL[gr]] for gr in GROUPS})
row("emoji+quickchat", {gr: [p["emoji"] + p["chat"] for p in PL[gr]] for gr in GROUPS})
row("donations", {gr: [p["donate"] for p in PL[gr]] for gr in GROUPS})

print("\n### Betrayal timing: break -> first attack on that same target")
print("| group | n breaks | attack within 30 s | within 120 s | none later | median lag (s) | other attacks in 30 s before break (per break) | breaks received from other humans |\n|---|---|---|---|---|---|---|---|")
recv = collections.Counter()
for g in G:
    pid2 = {p["pid"]: p for p in g["players"]}
    for p in g["players"]:
        for r in p["brk"]:
            if r[1] in pid2:
                recv[pid2[r[1]]["group"]] += 1
for gr in GROUPS:
    lags = []
    n = 0
    pre = 0
    for p in PL[gr]:
        for r in p["brk"]:
            n += 1
            nxt = [x[0] - r[0] for x in p["attacks"] if x[3] == r[1] and x[0] >= r[0]]
            lags.append(min(nxt) if nxt else None)
            pre += sum(1 for x in p["attacks"] if r[0] - 30 <= x[0] < r[0])
    ok = [l for l in lags if l is not None]
    print(f"| {gr} | {n} | {sum(1 for l in ok if l <= 30) / max(1, n):.2f} | {sum(1 for l in ok if l <= 120) / max(1, n):.2f} | {1 - len(ok) / max(1, n):.2f} | {st.median(ok) if ok else None} | {pre / max(1, n):.1f} | {recv[gr]} |")
print("\n### Engagements on humans: how many were against a target the attacker had broken an alliance with earlier")
for gr in GROUPS:
    tot = ex = 0
    for p in PL[gr]:
        broken = {r[1]: r[0] for r in p["brk"]}
        for b in p["bursts"]:
            if b[0][2] == "human":
                tot += 1
                if b[0][3] in broken and broken[b[0][3]] <= b[0][0]:
                    ex += 1
    print(f"{gr}: engagements on humans={tot}, after own break={ex} ({ex / max(1, tot):.2f})")

# ---------- game end
print("\n### Game end")
print("win_share:", q([g["win_share"] for g in G]), " survivors:", q([g["survivors"] for g in G]), " dur:", q([g["dur"] for g in G]))
print("dur by size:", {k: q([g['dur'] for g in G if lo <= g['nact'] < hi]) for k, (lo, hi) in {"<20": (0, 20), "20-49": (20, 50), "50+": (50, 999)}.items()})
print("winner final tiles K:", q([g["winner"]["final_tiles"] / 1e3 for g in G]))
print("winner peak / best other peak:", q([g["winner"]["peak"] / max(1, max(p["peak"] for p in g["players"] if p is not g["winner"])) for g in G]))
print("winner = most peak troops?", sum(1 for g in G if g["winner"]["peak"] == max(p["peak"] for p in g["players"])), "of", len(G))

print("games with win_share < 0.75:", [(g["gid"], round(g["win_share"], 2), g["dur"], g["survivors"]) for g in G if g["win_share"] < 0.75])
print("dates (UTC):", sorted({__import__('datetime').datetime.fromtimestamp(g['start'] / 1000, __import__('datetime').timezone.utc).strftime('%Y-%m-%d') for g in G}))
