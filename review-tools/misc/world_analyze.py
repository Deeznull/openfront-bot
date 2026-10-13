"""World-family human-FFA study (World / Giant World Map / World Inverted): winners (W) vs ranks 2-3 (T) vs others (O). Prints markdown tables.
Inputs (data only): tools/replays_world/<gid>.json (replay) + tools/replays_world/sim/<gid>.json (headless re-simulation, world_sim.mts).
Run: python -I world_analyze.py <World|Giant|Inverted|ALL> <WTO|TOP> > out.md   (WTO = winner/top3/others; TOP = top-10 trackerfront players vs everyone else)
Cell format: median [Q1-Q3] n=count.  Time is game seconds (turn/10)."""
import sys, os, re, json, glob, statistics as st, collections, math, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from load import parse

WD = os.path.join(HERE, "replays_world")
MAPSEL = sys.argv[1] if len(sys.argv) > 1 else "World"
SPLIT = sys.argv[2] if len(sys.argv) > 2 else "WTO"
GROUPS = {"WTO": ("W", "T", "O"), "TOP": ("TOP", "REST"), "TOPW": ("TW", "OW")}[SPLIT]
LABEL = {"W": "W (winner)", "T": "T (rank 2-3)", "O": "O (rest, alive>=5min)", "TOP": "TOP10 players (alive>=5min)", "REST": "everyone else (alive>=5min)", "TW": "WINNERS who are top-10 players", "OW": "WINNERS who are not top-10"}
MAPKEY = {"World": "World", "Giant World Map": "Giant", "World Inverted": "Inverted"}
MANIF = {"World": "world", "Giant": "giantworldmap", "Inverted": "worldinverted"}
MD = {}
for k, fn in MANIF.items():
    m_ = json.load(open(os.path.join(HERE, "maps", fn + "_manifest.json"), encoding="utf-8"))
    MD[k] = dict(W=m_["map"]["width"], H=m_["map"]["height"], W4=m_["map4x"]["width"],
                 NAT=[(n["name"], n["coordinates"][0], n["coordinates"][1]) for n in m_["nations"] if "coordinates" in n])
NAT = MD["World"]["NAT"]
COMMITSEL = sys.argv[3] if len(sys.argv) > 3 else "any"   # "v34" = only replays recorded on engine commit 3f5633b9
V34 = "3f5633b92c9508461e6e2b9e1f926487a1804c9f"
# Top-10 (trackerfront) players are identified by the OpenFront publicID of the in-game player: taken from the replay's
# winner when the tracker says that player won, else from an exact username match (usernames differ from tracker names).
TOPPID = {}
_tg = json.load(open(os.path.join(HERE, "top_player_games.json"), encoding="utf-8"))["games"]
for _g in _tg:
    _f = os.path.join(HERE, "replays_world", _g["game_id"] + ".json")
    if not os.path.exists(_f): continue
    _d = json.load(open(_f, encoding="utf-8")); _w = _d["info"].get("winner"); _pl = {p["clientID"]: p for p in _d["info"]["players"]}
    for _t in _g["top_players"]:
        if _t.get("won") and _w and _w[0] == "player" and _w[1] in _pl and _pl[_w[1]].get("publicID"): TOPPID[_pl[_w[1]]["publicID"]] = _t["name"]
        else:
            for _p in _d["info"]["players"]:
                if (_p.get("username") or "").lower() == _t["name"].lower() and _p.get("publicID"): TOPPID.setdefault(_p["publicID"], _t["name"])
REGION_OF = {}
for reg, names in {
    "NA west coast (Alaska/Yukon/California)": ["Alaska", "Yukon", "California"],
    "NA interior+east (US/Canada/Quebec/Texas)": ["United States", "Canada", "Quebec", "Nunavut", "Texas"],
    "Mexico/Caribbean": ["Mexico", "Cuba"],
    "S.America north+Andes": ["Colombia", "Venezuela", "Peru", "Bolivia"],
    "S.America Brazil": ["Brazil"],
    "S.America south": ["Argentina", "Uruguay"],
    "Greenland/Iceland": ["Greenland", "Iceland"],
    "Europe west/centre": ["United Kingdom", "Ireland", "Spain", "France", "Italy", "Germany"],
    "Scandinavia/Baltic": ["Norway", "Sweden", "Finland", "Latvia"],
    "Eastern Europe": ["Poland", "Belarus", "Ukraine", "Romania"],
    "Turkey/Middle East": ["Türkiye", "Saudi Arabia", "Iran", "Oman"],
    "Russia/Siberia/Kazakhstan/Mongolia": ["Russia", "Siberia", "Kazakhstan", "Mongolia"],
    "China/Japan/Taiwan": ["China", "Taiwan", "Japan"],
    "South Asia": ["India", "Pakistan", "Bhutan", "Sri Lanka"],
    "SE Asia/Indonesia": ["Thailand", "Philippines", "Indonesia"],
    "Australia/NZ": ["Australia", "New Zealand"],
    "North Africa (Morocco-Egypt)": ["Morocco", "Algeria", "Libya", "Egypt"],
    "West Africa coast (Senegal)": ["Senegal"],
    "Gulf of Guinea (Benin)": ["Benin"],
    "Sahel/Sudan (Niger/Chad/Sudan)": ["Niger", "Chad", "Sudan"],
    "Central+South Africa": ["DR Congo", "Zambia", "Namibia", "South Africa", "Madagascar"],
    "East Africa (Ethiopia/Kenya)": ["Ethiopia", "Kenya"],
    "Antarctica": ["Antarctica", "West Antarctica", "East Antarctica"],
}.items():
    for nm in names: REGION_OF[nm] = reg
assert all(n[0] in REGION_OF for n in NAT), [n[0] for n in NAT if n[0] not in REGION_OF]
SENEGAL = (845, 425)


def q(xs, f=None):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return "n=0"
    n = len(xs)
    g = lambda p: xs[min(n - 1, int(p * n))]
    fm = f or (lambda v: f"{v:.3g}")
    return f"{fm(st.median(xs))} [{fm(g(.25))}-{fm(g(.75))}] n={n}"


def share(xs):
    xs = list(xs)
    return f"{sum(xs) / max(1, len(xs)):.2f} n={len(xs)}"


def row(label, d, fmt=q):
    print(f"| {label} | " + " | ".join(fmt(d[g]) for g in GROUPS) + " |")


def head(title, note=""):
    print(f"\n#### {title}\n" + (note + "\n" if note else "") + "| metric | " + " | ".join(LABEL[x] for x in GROUPS) + " |\n|---|" + "---|" * len(GROUPS))


# ---------------- load
G = []
for f in sorted([f for f in glob.glob(os.path.join(WD, "*.json")) if re.fullmatch(r"[A-Za-z0-9]{10}", os.path.basename(f)[:-5])]):
    gid = os.path.basename(f)[:-5]
    d = json.load(open(f, encoding="utf-8"))
    mk = MAPKEY.get(d["info"]["config"]["gameMap"])
    if mk is None or d["info"]["config"]["gameMode"] != "Free For All": continue
    if MAPSEL != "ALL" and mk != MAPSEL: continue
    g = parse(d)
    if not g or g["nact"] < 5: continue
    g["mk"] = mk
    if COMMITSEL == "v34" and d["gitCommit"] != V34: continue
    pubs = {p["clientID"]: p.get("publicID") for p in d["info"]["players"]}
    lastsp = {}
    for turn in d["turns"]:
        for it in turn["intents"]:
            if it.get("type") == "spawn": lastsp[it.get("clientID")] = it.get("tile")
    W_ = MD[mk]["W"] if d["info"]["config"].get("gameMapSize", "Normal") != "Compact" else MD[mk]["W4"]
    sc_ = 1 if d["info"]["config"].get("gameMapSize", "Normal") != "Compact" else 2
    for p in g["players"]:
        p["top"] = pubs.get(p["cid"]) in TOPPID; p["topname"] = TOPPID.get(pubs.get(p["cid"]))
        tl = lastsp.get(p["cid"])
        p["xy"] = None if tl is None else ((tl % W_) * sc_, (tl // W_) * sc_)
        p.update(sa=[], sb=[], sfirsts=[], sreq=[], sbroke=[], small=None, hi=None)
    g["commit"] = d["gitCommit"]
    g["size"] = d["info"]["config"].get("gameMapSize", "Normal")
    g["maxp"] = d["info"]["config"].get("maxPlayers")
    sp = os.path.join(WD, "sim", gid + ".json")
    g["sim"] = None
    if os.path.exists(sp):
        s = json.load(open(sp, encoding="utf-8"))
        if s["compared"] > 0 and s["matches"] == s["compared"]: g["sim"] = s
    G.append(g)

if SPLIT == "TOP": G = [g for g in G if any(p["top"] for p in g["players"])]
PL = {x: [] for x in GROUPS}
for g in G:
    s = g["sim"]
    small = {h["cid"]: h["small"] for h in s["humans"]} if s else {}
    hidx = {h["cid"]: i for i, h in enumerate(s["humans"])} if s else {}
    for p in g["players"]:
        p["g"] = g
        p["small"] = small.get(p["cid"])
        p["hi"] = hidx.get(p["cid"])
        if p["end"] < 300 and (SPLIT == "TOP" or p["group"] == "O"): continue
        if SPLIT == "TOPW":
            if p["group"] != "W": continue
            PL["TW" if p["top"] else "OW"].append(p)
        else:
            PL[p["group"] if SPLIT == "WTO" else ("TOP" if p["top"] else "REST")].append(p)
ALL = sum(PL.values(), [])
GS = [g for g in G if g["sim"]]
print(f"split={SPLIT} maps={MAPSEL} commit={COMMITSEL} games={len(G)} (simulated and hash-verified: {len(GS)}); players " + " ".join(f"{k}={len(v)}" for k, v in PL.items()))


# ---------------- sim-derived per-player features
def sample_at(g, t):
    s = g["sim"]; k = int(round(t * 10 / 50))
    return s["samples"][k] if k < len(s["samples"]) else None


def tiles_at(p, t):
    g = p["g"]; r = sample_at(g, t)
    if r is None or p["hi"] is None: return None
    return r[3 + 4 * p["hi"]]


def troops_frac_at(p, t):
    g = p["g"]; r = sample_at(g, t)
    if r is None or p["hi"] is None: return None
    i = 3 + 4 * p["hi"]
    if r[i] == 0: return None
    return r[i + 1] / max(1, r[i + 3])


def gold_at(p, t):
    g = p["g"]; r = sample_at(g, t)
    if r is None or p["hi"] is None or r[3 + 4 * p["hi"]] == 0: return None
    return r[3 + 4 * p["hi"] + 2] / 1e3


def human_tiles_total(g, t):
    r = sample_at(g, t)
    if r is None: return None
    return sum(r[3 + 4 * i] for i in range(len(g["sim"]["humans"])))


def tile_share_at(p, t):
    v = tiles_at(p, t)
    if v is None: return None
    return v / max(1, human_tiles_total(p["g"], t))


for g in GS:
    s = g["sim"]
    sm = s["smallMap"]
    # structure events: (t, owner small, type, state 0 built/1 constructing/2 gone), first time seen per unit id
    first = {}
    for t, uid, own, ut, state in s["ev"]["unit"]:
        if uid not in first: first[uid] = (t / 10, own, ut)
    g["firsts"] = collections.defaultdict(list)  # small -> [(t, type)]
    for uid, (t, own, ut) in first.items(): g["firsts"][own].append((t, ut))
    for o in g["firsts"]: g["firsts"][o].sort()
    g["req"] = collections.defaultdict(list)     # requestor small -> [(t, recipient small, accepted)]
    acc = {(a, b, ): 0 for _, a, b, _ in s["ev"]["reply"]}
    repl = collections.defaultdict(list)
    for t, a, b, ok in s["ev"]["reply"]: repl[(a, b)].append((t, ok))
    for t, a, b in s["ev"]["alliance"]:
        ok = None
        for (rt, rok) in repl.get((a, b), []):
            if rt >= t: ok = rok; break
        g["req"][a].append((t / 10, b, ok))
    g["broke"] = collections.defaultdict(list)
    for t, a, b in s["ev"]["broke"]: g["broke"][a].append((t / 10, b))
    g["spawn_xy"] = {}
    W_ = MD[g["mk"]]["W"] if g["size"] != "Compact" else MD[g["mk"]]["W4"]
    sc = 1 if g["size"] != "Compact" else 2
    for t, kind, small, tile in [m for m in s["misc"] if m[1] == "spawn"]:
        g["spawn_xy"][small] = ((tile % W_) * sc, (tile // W_) * sc)
    # winner #1 timing
    wi = next(h for h in range(len(s["humans"])) if s["humans"][h]["cid"] == g["winner"]["cid"])
    g["wi"] = wi
    rank_h, rank_all = [], []
    nh = len(s["humans"])
    for r in s["samples"]:
        tl = [r[3 + 4 * i] for i in range(nh)]
        oth = max(tl[i] for i in range(nh) if i != wi) if nh > 1 else 0
        rank_h.append(tl[wi] > oth and tl[wi] > 0)
        rank_all.append(tl[wi] > oth and tl[wi] > r[1] and tl[wi] > 0)
    g["rank_h"], g["rank_all"] = rank_h, rank_all

    def first_true(L, after=0):
        for k, v in enumerate(L):
            if v and k * 5 >= after: return k * 5.0
        return None

    def lead_from(L):  # start of the final unbroken run of True
        k = len(L)
        while k > 0 and L[k - 1]: k -= 1
        return k * 5.0 if k < len(L) else None
    g["w_first1_h"] = first_true(rank_h)
    g["w_first1_all"] = first_true(rank_all)
    g["w_lead_h"] = lead_from(rank_h)
    g["w_lead_all"] = lead_from(rank_all)

# per-player attacks join from sim
for g in GS:
    s = g["sim"]
    byc = collections.defaultdict(list)
    for t, sm, tt, tr, snd, tiles, mx, tT, tTiles, tid in s["att"]:
        byc[sm].append(dict(t=t / 10, cls=tt, troops=tr, snd=snd, tiles=tiles, mx=mx, tT=tT, tTiles=tTiles))
    bb = collections.defaultdict(list)
    for t, sm, tr, snd, tiles, mx in s["boats"]:
        bb[sm].append(dict(t=t / 10, troops=tr, snd=snd, tiles=tiles, mx=mx))
    for p in g["players"]:
        p["sa"] = byc.get(p["small"], [])
        p["sb"] = bb.get(p["small"], [])
        p["sfirsts"] = g["firsts"].get(p["small"], [])
        p["sreq"] = g["req"].get(p["small"], [])
        p["sbroke"] = g["broke"].get(p["small"], [])

# =====================================================================
print("\n### 0. Sample")
print(f"- games {len(G)}, simulation-verified {len(GS)} (all recorded hash checkpoints match the v34 engine commit 3f5633b9)")
print("- game start (UTC) by day:", dict(sorted(collections.Counter(datetime.datetime.fromtimestamp(g['start'] / 1000, datetime.timezone.utc).strftime('%m-%d') for g in G).items())))
print("- game start hour (UTC) histogram:", dict(sorted(collections.Counter(datetime.datetime.fromtimestamp(g['start'] / 1000, datetime.timezone.utc).hour for g in G).items())))
print("- engine commits:", dict(collections.Counter(g['commit'][:8] for g in G)))
print("- active humans per game:", q([g['nact'] for g in G]), "; lobby maxPlayers:", dict(sorted(collections.Counter(g['maxp'] for g in G).items())))
print("- duration (s):", q([g['dur'] for g in G]), "; winner share of living human tiles:", q([g['win_share'] for g in G]), "; survivors at end:", q([g['survivors'] for g in G]))
print("- spawn phase end (earliest attack, s):", q([g['beg'] for g in G]))

# =====================================================================
if SPLIT == "TOP":
    print("%s#### Top-10 players in this sample (identified by publicID): games, wins, top-3 finishes, median finishing rank percentile (rank / active humans, lower is better)" % chr(10))
    print("| player | games | wins | top-3 | median rank pct |" + chr(10) + "|---|---|---|---|---|")
    for nm in sorted(set(TOPPID.values())):
        ps = [p for g in G for p in g["players"] if p["topname"] == nm]
        if ps: print(f"| {nm} | {len(ps)} | {sum(1 for p in ps if p['group'] == 'W')} | {sum(1 for p in ps if p['group'] in ('W', 'T'))} | {st.median(p['rank'] / p['g']['nact'] for p in ps):.2f} |")
    allt = [p for g in G for p in g["players"] if p["top"]]
    print(f"{chr(10)}All top-10 player-games: {len(allt)}, winners {sum(1 for p in allt if p['group'] == 'W')} ({sum(1 for p in allt if p['group'] == 'W') / max(1, len(allt)):.2f}); expected by chance {st.mean(1 / p['g']['nact'] for p in allt):.3f}")
print("\n### 1. Spawn regions (final spawn tile -> nearest of the 72 World Nation anchors -> region)")
rows = collections.defaultdict(lambda: dict(n=0, w=0, t=0, exp=0.0, tiles5=[], alive10=[], ok=0))
for g in GS:
    nact = g["nact"]
    for p in g["players"]:
        if p["xy"] is None: continue
        x, y = p["xy"]
        if g["mk"] == "World":
            nm, dist = min(((n[0], math.hypot(n[1] - x, n[2] - y)) for n in NAT), key=lambda a: a[1])
            reg = REGION_OF[nm]
            if reg.startswith("West Africa") and math.hypot(SENEGAL[0] - x, SENEGAL[1] - y) > 90: reg = "Sahel/Sudan (Niger/Chad/Sudan)"  # far from the bulge: not the bulge
        else:  # Giant / Inverted: coarse 4 (west-east) x 3 (north-south) grid of the full map
            reg = f"{g['mk']} grid row{min(2, int(3 * y / MD[g['mk']]['H']))}/col{min(3, int(4 * x / MD[g['mk']]['W']))}"
        p["region"] = reg
        r = rows[reg]
        r["n"] += 1; r["w"] += p["group"] == "W"; r["t"] += p["group"] in ("W", "T"); r["exp"] += 1 / nact
        r["tiles5"].append(tiles_at(p, 300) if p["end"] >= 300 else None); r["alive10"].append(1 if p["end"] >= 600 else 0)
print("| region | spawns | wins | win rate (expected) | W+T rank<=3 | top-3 rate (expected) | median tiles at 5 min | alive at 10 min |\n|---|---|---|---|---|---|---|---|")
for reg, r in sorted(rows.items(), key=lambda kv: -kv[1]["n"]):
    ex3 = 0.0
    print(f"| {reg} | {r['n']} | {r['w']} | {r['w'] / r['n']:.3f} ({r['exp'] / r['n']:.3f}) | {r['t']} | {r['t'] / r['n']:.3f} ({3 * r['exp'] / r['n']:.3f}) | {(format(st.median([v for v in r['tiles5'] if v is not None]), '.0f') if any(v is not None for v in r['tiles5']) else 'NA')} | {sum(r['alive10']) / r['n']:.2f} |")

head("Spawn crowding (px on each map's own full-size grid)")
def near_h(p):
    if p["xy"] is None: return None
    ds = [math.hypot(p["xy"][0] - q_["xy"][0], p["xy"][1] - q_["xy"][1]) for q_ in p["g"]["players"] if q_ is not p and q_["xy"]]
    return min(ds) if ds else None
def near_n(p):
    if p["xy"] is None: return None
    return min(math.hypot(p["xy"][0] - n[1], p["xy"][1] - n[2]) for n in MD[p["g"]["mk"]]["NAT"])
row("distance to nearest other human spawn", {gr: [near_h(p) for p in PL[gr]] for gr in GROUPS})
row("distance to nearest Nation anchor", {gr: [near_n(p) for p in PL[gr]] for gr in GROUPS})
row("humans within 150 px", {gr: [None if p["xy"] is None else sum(1 for q_ in p["g"]["players"] if q_ is not p and q_["xy"] and math.hypot(p["xy"][0] - q_["xy"][0], p["xy"][1] - q_["xy"][1]) < 150) for p in PL[gr]] for gr in GROUPS})
row("spawn clicks (re-picks)", {gr: [len(p["spawn"]) for p in PL[gr]] for gr in GROUPS})

# =====================================================================
print("\n### 2. First attack, first-3-minutes activity and targets (clock starts when the spawn phase ends, i.e. at the first attack of any player)")
def rel(p, t): return t - p["g"]["beg"]
head("Timing and counts")
row("first attack (s after spawn end)", {gr: [rel(p, p["attacks"][0][0]) if p["attacks"] else None for p in PL[gr]] for gr in GROUPS})
row("first attack on a Tribe (s after spawn end)", {gr: [next((rel(p, x[0]) for x in p["attacks"] if x[2] == "bot"), None) for p in PL[gr]] for gr in GROUPS})
row("first attack on a Nation (s after spawn end)", {gr: [next((rel(p, x[0]) for x in p["attacks"] if x[2] == "nation"), None) for p in PL[gr]] for gr in GROUPS})
row("first attack on a human (s after spawn end)", {gr: [next((rel(p, x[0]) for x in p["attacks"] if x[2] == "human"), None) for p in PL[gr]] for gr in GROUPS})
for T in (60, 180, 300):
    row(f"attack clicks in first {T} s", {gr: [sum(1 for x in p["attacks"] if rel(p, x[0]) < T) for p in PL[gr]] for gr in GROUPS})
for T in (180,):
    row(f"distinct targets in first {T} s", {gr: [len({x[3] for x in p["attacks"] if rel(p, x[0]) < T and x[3] is not None}) for p in PL[gr]] for gr in GROUPS})
PH = [(0, 180), (180, 300), (300, 600), (600, 1e9)]
PHN = ["0-3m", "3-5m", "5-10m", "10m+"]
def overlap(p, a, b): return max(0, min(b, p["end"] - p["g"]["beg"]) - a)
head("Attack clicks per alive minute")
for i, (a, b) in enumerate(PH):
    row(PHN[i], {gr: [sum(1 for x in p["attacks"] if a <= rel(p, x[0]) < b) / (overlap(p, a, b) / 60) for p in PL[gr] if overlap(p, a, b) >= 30] for gr in GROUPS})
print("\n#### Target mix: share of attack CLICKS / of TROOPS by target class (pooled)")
print("| group | window | clicks: wild | tribe | nation | human | troops: wild | tribe | nation | human | n clicks |\n|---|---|---|---|---|---|---|---|---|---|---|")
TC = ["wild", "bot", "nation", "human"]
for gr in GROUPS:
    for nm, (a, b) in zip(["first 3 min", "3-10 min", "10 min+"], [(0, 180), (180, 600), (600, 1e9)]):
        c = collections.Counter(); t = collections.Counter()
        for p in PL[gr]:
            for x in p["attacks"]:
                if a <= rel(p, x[0]) < b: c[x[2]] += 1; t[x[2]] += x[1]
        N = sum(c.values()) or 1; T_ = sum(t.values()) or 1
        print(f"| {gr} | {nm} | " + " | ".join(f"{c[k] / N:.2f}" for k in TC) + " | " + " | ".join(f"{t[k] / T_:.2f}" for k in TC) + f" | {N} |")
head("Share of players who attacked a class within the first 3 min / first 5 min")
for k in ("bot", "nation", "human"):
    print(f"| {k} <3m / <5m | " + " | ".join(
        f"{sum(1 for p in PL[gr] if any(x[2] == k and rel(p, x[0]) < 180 for x in p['attacks'])) / len(PL[gr]):.2f} / {sum(1 for p in PL[gr] if any(x[2] == k and rel(p, x[0]) < 300 for x in p['attacks'])) / len(PL[gr]):.2f}" for gr in GROUPS) + " |")
head("Human-on-human war")
row("distinct human targets attacked (whole game)", {gr: [len({x[3] for x in p["attacks"] if x[2] == "human"}) for p in PL[gr]] for gr in GROUPS})
row("human eliminations (stats.kills)", {gr: [len(p["stats"].get("kills") or []) for p in PL[gr]] for gr in GROUPS})
row("time of first human elimination (s)", {gr: [min(int(k["tick"]) / 10 for k in p["stats"]["kills"]) if p["stats"].get("kills") else None for p in PL[gr]] for gr in GROUPS})
row("conquests of humans (stats.conquests[0])", {gr: [int(p["stats"]["conquests"][0]) if p["stats"].get("conquests") else 0 for p in PL[gr]] for gr in GROUPS})
row("conquests of Nations (stats.conquests[1])", {gr: [int(p["stats"]["conquests"][1]) if p["stats"].get("conquests") and len(p["stats"]["conquests"]) > 1 else 0 for p in PL[gr]] for gr in GROUPS})
row("conquests of Tribes (stats.conquests[2])", {gr: [int(p["stats"]["conquests"][2]) if p["stats"].get("conquests") and len(p["stats"]["conquests"]) > 2 else 0 for p in PL[gr]] for gr in GROUPS})

# =====================================================================
print("\n### 3. Troops sent per attack (% of the sender's troops at the moment of the click; re-simulated)")
def pct(x): return 100 * x["troops"] / max(1, x["snd"])
head("Percent of own troops per attack click")
for i, (a, b) in enumerate(PH):
    row(PHN[i] + " (median of per-player medians)", {gr: [st.median(pct(x) for x in p["sa"] if a <= rel(p, x["t"]) < b) for p in PL[gr] if p["sa"] and any(a <= rel(p, x["t"]) < b for x in p["sa"])] for gr in GROUPS})
row("FIRST attack click", {gr: [pct(p["sa"][0]) if p["sa"] else None for p in PL[gr]] for gr in GROUPS})
row("first 3 attack clicks, mean", {gr: [st.mean(pct(x) for x in p["sa"][:3]) if p["sa"] else None for p in PL[gr]] for gr in GROUPS})
for k, nm in (("wild", "wilderness"), ("bot", "Tribe"), ("nation", "Nation"), ("human", "human")):
    row(f"clicks on {nm} (per-player median)", {gr: [st.median(pct(x) for x in p["sa"] if x["cls"] == k) for p in PL[gr] if any(x["cls"] == k for x in p["sa"])] for gr in GROUPS})
row("own troops at click / own max troops", {gr: [st.median(x["snd"] / max(1, x["mx"]) for x in p["sa"]) for p in PL[gr] if p["sa"]] for gr in GROUPS})
row("sent / target's home troops, clicks on humans (per-player median)", {gr: [st.median(x["troops"] / max(1, x["tT"]) for x in p["sa"] if x["cls"] == "human" and x["tT"] > 0) for p in PL[gr] if any(x["cls"] == "human" and x["tT"] > 0 for x in p["sa"])] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("sent / target's home troops, clicks on Nations", {gr: [st.median(x["troops"] / max(1, x["tT"]) for x in p["sa"] if x["cls"] == "nation" and x["tT"] > 0) for p in PL[gr] if any(x["cls"] == "nation" and x["tT"] > 0 for x in p["sa"])] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("share of clicks on humans with sent >= 1.22x target troops", {gr: [sum(1 for x in p["sa"] if x["cls"] == "human" and x["tT"] > 0 and x["troops"] >= 1.22 * x["tT"]) / max(1, sum(1 for x in p["sa"] if x["cls"] == "human" and x["tT"] > 0)) for p in PL[gr] if any(x["cls"] == "human" and x["tT"] > 0 for x in p["sa"])] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("target's tiles / own tiles, clicks on humans (median)", {gr: [st.median(x["tTiles"] / max(1, x["tiles"]) for x in p["sa"] if x["cls"] == "human") for p in PL[gr] if any(x["cls"] == "human" for x in p["sa"])] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
print("\n#### Histogram of attack-click size (pooled, % of own troops), share of clicks")
BINS = [(0, 5), (5, 15), (15, 25), (25, 35), (35, 50), (50, 75), (75, 101)]
print("| group | " + " | ".join(f"{a}-{b}%" for a, b in BINS) + " | n |\n|---|" + "---|" * (len(BINS) + 1))
for gr in GROUPS:
    v = [pct(x) for p in PL[gr] for x in p["sa"]]
    print(f"| {gr} | " + " | ".join(f"{sum(1 for z in v if a <= z < b) / max(1, len(v)):.2f}" for a, b in BINS) + f" | {len(v)} |")

# =====================================================================
print("\n### 4. Economy and build order (structure creation events from the re-simulation; time = when the build was placed)")
UN = ["City", "Port", "Factory", "Defense Post", "Missile Silo", "SAM Launcher", "Warship"]
def firstt(p, u): return next((t for t, ut in p["sfirsts"] if ut == u), None)
head("First build time (s), among players who built it")
for u in UN: row(u, {gr: [firstt(p, u) for p in PL[gr] if p["sa"] is not None and p["g"]["sim"]] for gr in GROUPS})
row("first nuke launch (Atom/H-bomb/MIRV)", {gr: [next((t for t, ut in p["sfirsts"] if ut in ("Atom Bomb", "Hydrogen Bomb", "MIRV")), None) for p in PL[gr] if p["g"]["sim"]] for gr in GROUPS})
head("Share with >=1 by 5 min / by 10 min (of those alive at that time)")
for u in UN:
    out = []
    for gr in GROUPS:
        cells = []
        for T in (300, 600):
            al = [p for p in PL[gr] if p["g"]["sim"] and p["end"] >= T]
            cells.append(f"{sum(1 for p in al if (firstt(p, u) or 1e9) < T) / max(1, len(al)):.2f}")
        out.append(" / ".join(cells))
    print(f"| {u} | " + " | ".join(out) + " |")
head("Count of finished-or-started structures by time (players alive then)")
for u in ("City", "Port", "Factory"):
    for T in (300, 600):
        row(f"{u} by {T // 60} min", {gr: [sum(1 for t, ut in p["sfirsts"] if ut == u and t < T) for p in PL[gr] if p["g"]["sim"] and p["end"] >= T] for gr in GROUPS})
row("Defense Posts by 10 min", {gr: [sum(1 for t, ut in p["sfirsts"] if ut == "Defense Post" and t < 600) for p in PL[gr] if p["g"]["sim"] and p["end"] >= 600] for gr in GROUPS})
row("SAM Launchers by 15 min", {gr: [sum(1 for t, ut in p["sfirsts"] if ut == "SAM Launcher" and t < 900) for p in PL[gr] if p["g"]["sim"] and p["end"] >= 900] for gr in GROUPS})
row("Missile Silos by 15 min", {gr: [sum(1 for t, ut in p["sfirsts"] if ut == "Missile Silo" and t < 900) for p in PL[gr] if p["g"]["sim"] and p["end"] >= 900] for gr in GROUPS})
head("Gold on hand (thousands) and tiles")
for T in (180, 300, 600):
    row(f"gold at {T // 60} min (K)", {gr: [gold_at(p, T) for p in PL[gr] if p["g"]["sim"] and p["end"] >= T] for gr in GROUPS})
for T in (60, 180, 300, 600):
    row(f"tiles at {T // 60 if T >= 60 else T} min", {gr: [tiles_at(p, T) for p in PL[gr] if p["g"]["sim"] and p["end"] >= T] for gr in GROUPS})
for T in (60, 180, 300, 600):
    row(f"troops / max troops at {T // 60} min", {gr: [troops_frac_at(p, T) for p in PL[gr] if p["g"]["sim"] and p["end"] >= T] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("peakTroops (K)", {gr: [p["peak"] / 1e3 for p in PL[gr]] for gr in GROUPS})

STRUCT = {"City": "C", "Port": "P", "Factory": "F", "Defense Post": "D", "Missile Silo": "S", "SAM Launcher": "A"}
def seq(p, n, tmax=600):
    return "".join(STRUCT[ut] for t, ut in p["sfirsts"] if ut in STRUCT and t < tmax)[:n]
print("\n#### Build order in the first 10 min (C=City P=Port F=Factory D=Defense Post S=Silo A=SAM; first 4 structures; players alive at 10 min with >=1 structure)")
print("| group | n | first build: C | P | F | D | other/none | top 4-letter openings (share) |\n|---|---|---|---|---|---|---|---|")
for gr in GROUPS:
    al = [p for p in PL[gr] if p["g"]["sim"] and p["end"] >= 600]
    sq = [seq(p, 4) for p in al]
    first = collections.Counter((s[0] if s else "-") for s in sq)
    top = collections.Counter(sq).most_common(6)
    n = max(1, len(al))
    print(f"| {gr} | {len(al)} | " + " | ".join(f"{first[k] / n:.2f}" for k in "CPFD") + f" | {1 - sum(first[k] for k in 'CPFD') / n:.2f} | " + ", ".join(f"{s or 'none'} {c / n:.2f}" for s, c in top) + " |")
print("\n#### Cities+Ports+Factories placed by minute (median per group, players alive at that minute)")
print("| minute | W C/P/F | T C/P/F | O C/P/F |\n|---|---|---|---|")
for m in (2, 3, 5, 7, 10):
    cells = []
    for gr in GROUPS:
        al = [p for p in PL[gr] if p["g"]["sim"] and p["end"] >= m * 60]
        cells.append("/".join(f"{st.median([sum(1 for t, ut in p['sfirsts'] if ut == u and t < m * 60) for p in al]) if al else 0:g}" for u in ("City", "Port", "Factory")) + f" (n={len(al)})")
    print(f"| {m} | " + " | ".join(cells) + " |")

# =====================================================================
print("\n### 5. Boats (transport ship intents)")
head("Boats")
SIMP = lambda gr: [p for p in PL[gr] if p["g"]["sim"]]
row("first boat (s)", {gr: [p["sb"][0]["t"] if p["sb"] else None for p in SIMP(gr)] for gr in GROUPS})
row("first boat (s after spawn end)", {gr: [rel(p, p["sb"][0]["t"]) if p["sb"] else None for p in SIMP(gr)] for gr in GROUPS})
for T in (120, 300, 600):
    row(f"boats launched by {T // 60} min", {gr: [sum(1 for b in p["sb"] if b["t"] < T) for p in SIMP(gr) if p["end"] >= T] for gr in GROUPS})
row("boats total (whole game)", {gr: [len(p["sb"]) for p in SIMP(gr)] for gr in GROUPS})
row("share with >=1 boat by 2 min", {gr: [1 if any(b["t"] < 120 for b in p["sb"]) else 0 for p in SIMP(gr)] for gr in GROUPS}, fmt=share)
row("share with >=1 boat by 5 min", {gr: [1 if any(b["t"] < 300 for b in p["sb"]) else 0 for p in SIMP(gr)] for gr in GROUPS}, fmt=share)
row("boat size, % of own troops (per-player median)", {gr: [st.median(100 * b["troops"] / max(1, b["snd"]) for b in p["sb"]) for p in SIMP(gr) if p["sb"]] for gr in GROUPS})
row("first boat size, % of own troops", {gr: [100 * p["sb"][0]["troops"] / max(1, p["sb"][0]["snd"]) if p["sb"] else None for p in SIMP(gr)] for gr in GROUPS})
row("boats / (boats + attack clicks)", {gr: [len(p["sb"]) / max(1, len(p["sb"]) + len(p["sa"])) for p in SIMP(gr)] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("boats per alive minute", {gr: [len(p["sb"]) / max(1, (p["end"] - p["g"]["beg"]) / 60) for p in SIMP(gr)] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("trade ships launched (stats.boats.trade[0])", {gr: [int(p["stats"]["boats"]["trade"][0]) if p["stats"].get("boats", {}).get("trade") else 0 for p in PL[gr]] for gr in GROUPS})
row("transports that arrived / launched (stats.boats.trans)", {gr: [int(p["stats"]["boats"]["trans"][1]) / int(p["stats"]["boats"]["trans"][0]) for p in PL[gr] if p["stats"].get("boats", {}).get("trans") and int(p["stats"]["boats"]["trans"][0]) > 0] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))

# =====================================================================
print("\n### 6. Alliances and betrayals (re-simulated request/reply events)")
sm_type = lambda g, s_: g["sim"]["smallMap"].get(str(s_), {}).get("type")
head("Alliance requests SENT")
row("requests total", {gr: [len(p["sreq"]) for p in SIMP(gr)] for gr in GROUPS})
for nm, (a, b) in zip(["0-3m", "3-10m", "10m+"], [(0, 180), (180, 600), (600, 1e9)]):
    row(f"requests {nm} (after spawn end)", {gr: [sum(1 for r in p["sreq"] if a <= rel(p, r[0]) < b) for p in SIMP(gr)] for gr in GROUPS})
row("requests to humans", {gr: [sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "HUMAN") for p in SIMP(gr)] for gr in GROUPS})
row("requests to Nations", {gr: [sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "NATION") for p in SIMP(gr)] for gr in GROUPS})
row("first request (s after spawn end)", {gr: [rel(p, p["sreq"][0][0]) if p["sreq"] else None for p in SIMP(gr)] for gr in GROUPS})
row("requests accepted (any)", {gr: [sum(1 for r in p["sreq"] if r[2] == 1) for p in SIMP(gr)] for gr in GROUPS})
row("accept rate, requests to humans (per-player, >=2 requests)", {gr: [sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "HUMAN" and r[2] == 1) / sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "HUMAN") for p in SIMP(gr) if sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "HUMAN") >= 2] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("accept rate, requests to Nations (per-player, >=2 requests)", {gr: [sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "NATION" and r[2] == 1) / sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "NATION") for p in SIMP(gr) if sum(1 for r in p["sreq"] if sm_type(p["g"], r[1]) == "NATION") >= 2] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
pooled = collections.Counter()
for gr in GROUPS:
    for p in SIMP(gr):
        for r in p["sreq"]:
            ty = sm_type(p["g"], r[1]); pooled[(gr, ty, r[2])] += 1
print("\nPooled accept rate by recipient type (accepted / all requests with a reply or expiry): ", {gr: {ty: f"{pooled[(gr, ty, 1)]}/{sum(pooled[(gr, ty, k)] for k in (0, 1, None))}" for ty in ("HUMAN", "NATION", "BOT")} for gr in GROUPS})
head("Alliances formed / held (stats.alliances) and betrayals")
row("alliances formed (stats.alliances[0])", {gr: [int(p["stats"]["alliances"][0]) if p["stats"].get("alliances") else 0 for p in PL[gr]] for gr in GROUPS})
row("alliances broken BY the other side (betrayed)", {gr: [int(p["stats"]["alliances"][1]) if p["stats"].get("alliances") and len(p["stats"]["alliances"]) > 1 else 0 for p in PL[gr]] for gr in GROUPS})
row("alliances expired", {gr: [int(p["stats"]["alliances"][2]) if p["stats"].get("alliances") and len(p["stats"]["alliances"]) > 2 else 0 for p in PL[gr]] for gr in GROUPS})
row("peak concurrent alliances", {gr: [int(p["stats"]["alliances"][4]) if p["stats"].get("alliances") and len(p["stats"]["alliances"]) > 4 else 0 for p in PL[gr]] for gr in GROUPS})
row("alliance extensions sent", {gr: [len(p["ext"]) for p in PL[gr]] for gr in GROUPS})
row("betrayals committed (stats.betrayals)", {gr: [int(p["stats"].get("betrayals", 0)) for p in PL[gr]] for gr in GROUPS})
row("share who ever betrayed", {gr: [1 if int(p["stats"].get("betrayals", 0)) > 0 else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
row("betrayals of humans", {gr: [sum(1 for r in p["sbroke"] if sm_type(p["g"], r[1]) == "HUMAN") for p in SIMP(gr)] for gr in GROUPS})
row("betrayals of Nations", {gr: [sum(1 for r in p["sbroke"] if sm_type(p["g"], r[1]) == "NATION") for p in SIMP(gr)] for gr in GROUPS})
row("time of first betrayal (s)", {gr: [p["sbroke"][0][0] for p in SIMP(gr) if p["sbroke"]] for gr in GROUPS})
row("betrayal time / game length", {gr: [r[0] / p["g"]["dur"] for p in SIMP(gr) for r in p["sbroke"]] for gr in GROUPS}, fmt=lambda xs: q(xs, lambda v: f"{v:.2f}"))
row("share who allied with >=1 and still won/top3 is the column; players with zero alliances formed", {gr: [1 if (not p["stats"].get("alliances") or int(p["stats"]["alliances"][0]) == 0) else 0 for p in PL[gr]] for gr in GROUPS}, fmt=share)
print("\n#### Betrayal outcome: after a break, did the breaker attack that victim within 30 s / 120 s?")
print("| group | breaks | attacked victim within 30 s | within 120 s | victim was human |\n|---|---|---|---|---|")
for gr in GROUPS:
    n = a30 = a120 = hv = 0
    for p in SIMP(gr):
        for t, vic in p["sbroke"]:
            n += 1
            nxt = [x["t"] - t for x in p["sa"] if x["tT"] is not None and False]
            # attacks carry the target small id as the last field in the raw sim rows; recompute
        sm_ = p["small"]
        for t, vic in p["sbroke"]:
            lag = [r[0] / 10 - t for r in p["g"]["sim"]["att"] if r[1] == sm_ and r[9] == vic and r[0] / 10 >= t]
            if lag and min(lag) <= 30: a30 += 1
            if lag and min(lag) <= 120: a120 += 1
            hv += sm_type(p["g"], vic) == "HUMAN"
    print(f"| {gr} | {n} | {a30 / max(1, n):.2f} | {a120 / max(1, n):.2f} | {hv / max(1, n):.2f} |")

# =====================================================================
print("\n### 7. When did the eventual winner first lead, and how long do games last")
head_ = "| metric | value |\n|---|---|"
print(head_)
print(f"| game length (s) | {q([g['dur'] for g in G])} |")
print(f"| winner first #1 in tiles among HUMANS (s) | {q([g['w_first1_h'] for g in GS])} |")
print(f"| winner first #1 in tiles among humans AND the biggest Nation (s) | {q([g['w_first1_all'] for g in GS])} |")
print(f"| winner's final unbroken lead among humans starts at (s) | {q([g['w_lead_h'] for g in GS])} |")
print(f"| winner's final unbroken lead (humans+Nations) starts at (s) | {q([g['w_lead_all'] for g in GS])} |")
print(f"| same, as fraction of game length | {q([g['w_lead_all'] / g['dur'] for g in GS if g['w_lead_all'] is not None], lambda v: f'{v:.2f}')} |")
print(f"| winner first #1 (humans+Nations), fraction of game length | {q([g['w_first1_all'] / g['dur'] for g in GS if g['w_first1_all'] is not None], lambda v: f'{v:.2f}')} |")
print("\n#### Is the winner already #1 (humans+Nations) at minute m? And how well does being #1 at minute m predict the win?")
print("| minute | winner is #1 | winner's rank among humans, median [Q1-Q3] | P(win) of whoever is #1 among humans | winner tile share of all human tiles |\n|---|---|---|---|---|")
for m in (2, 3, 5, 8, 10, 15):
    k = int(m * 60 / 5)
    base = [g for g in GS if g["dur"] > m * 60 + 30 and k < len(g["sim"]["samples"])]
    isn1 = [g["rank_all"][k] for g in base]
    ranks = []
    lead_win = []
    for g in base:
        r = g["sim"]["samples"][k]; nh = len(g["sim"]["humans"])
        tl = [r[3 + 4 * i] for i in range(nh)]
        ranks.append(1 + sum(1 for i in range(nh) if tl[i] > tl[g["wi"]]))
        top = max(range(nh), key=lambda i: tl[i]); lead_win.append(1 if top == g["wi"] else 0)
    shs = [g["sim"]["samples"][k][3 + 4 * g["wi"]] / max(1, sum(g["sim"]["samples"][k][3 + 4 * i] for i in range(len(g["sim"]["humans"])))) for g in base]
    print(f"| {m} | {sum(isn1)}/{len(isn1)} = {sum(isn1) / max(1, len(isn1)):.2f} | {q(ranks)} | {share(lead_win)} | {q(shs, lambda v: f'{v:.2f}')} |")
print("\n#### Tile share of all human tiles at minute m (players alive at m)")
print("| group | 3 min | 5 min | 10 min |\n|---|---|---|---|")
for gr in GROUPS:
    print(f"| {gr} | " + " | ".join(q([tile_share_at(p, T) for p in PL[gr] if p["g"]["sim"] and p["end"] >= T], lambda v: f"{v:.3f}") for T in (180, 300, 600)) + " |")
print("\n#### Winner's rank among all humans in tiles at minute m (count of games)")
for m in (3, 5, 10):
    k = int(m * 60 / 5); c = collections.Counter()
    for g in GS:
        if g["dur"] > m * 60 + 30 and k < len(g["sim"]["samples"]):
            r = g["sim"]["samples"][k]; nh = len(g["sim"]["humans"]); tl = [r[3 + 4 * i] for i in range(nh)]
            c[min(10, 1 + sum(1 for i in range(nh) if tl[i] > tl[g["wi"]]))] += 1
    print(f"- {m} min: " + ", ".join(f"rank {k_}{'+' if k_ == 10 else ''}: {v}" for k_, v in sorted(c.items())))

# =====================================================================
print("\n### 8. Other")
head("Stats")
row("final tiles (K)", {gr: [p["final_tiles"] / 1e3 for p in PL[gr]] for gr in GROUPS})
row("gold earned total (M)", {gr: [sum(int(v) for v in p["stats"].get("gold", [0])) / 1e6 for p in PL[gr]] for gr in GROUPS})
row("gold from conquering players (M)", {gr: [int(p["stats"]["gold"][1]) / 1e6 if len(p["stats"].get("gold", [])) > 1 else 0 for p in PL[gr]] for gr in GROUPS})
row("gold from trade ships (M)", {gr: [int(p["stats"]["gold"][2]) / 1e6 if len(p["stats"].get("gold", [])) > 2 else 0 for p in PL[gr]] for gr in GROUPS})
row("gold from own trains (M)", {gr: [int(p["stats"]["gold"][4]) / 1e6 if len(p["stats"].get("gold", [])) > 4 else 0 for p in PL[gr]] for gr in GROUPS})
row("atom/H/MIRV launched", {gr: [sum(int(p["stats"].get("bombs", {}).get(k, [0])[0]) for k in ("abomb", "hbomb", "mirv")) for p in PL[gr]] for gr in GROUPS})
row("nukes intercepted by own SAMs / launched at them (n/a), bombs landed on them: skip", {gr: [None for p in PL[gr]] for gr in GROUPS})
print("\nwinner = single highest peakTroops in", sum(1 for g in G if g["winner"]["peak"] == max(p["peak"] for p in g["players"])), "of", len(G), "games")
