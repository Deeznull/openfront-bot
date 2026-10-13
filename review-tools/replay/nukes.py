"""How players respond to incoming nukes, default 30+ FFA games in tools/replays_world (out/ffa30_index.csv, src=world).
Nuke launch = build_unit intent with unit Atom Bomb / Hydrogen Bomb / MIRV and a tile (clientID = launcher).
Hit on player P = a launch by someone else whose target tile is within R tiles (Chebyshev) of a non-nuke build
or spawn tile P had at that time. Approximate: captured structures are not tracked, no intercept or landing events.
Responses (W = winner, R = other hit players), measured from the first hit t0:
  SAM built in [t0-120, t0] (pre-emptive) and [t0, t0+60]; own nuke launched in [t0, t0+60];
  own attack in [t0, t0+30] and [t0, t0+60]; base rate = share of 30 s windows after t0 with an own attack.
Run: python -I tools/replay_tools/nukes.py"""
import csv, json, os, sys, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from spawn_tiles import terrain

R = 30
PRE, POST = 120, 60
NUKES = ("Atom Bomb", "Hydrogen Bomb", "MIRV")

rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if r["src"] == "world" and int(r["turns"] or 0) > 0]


def q(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return "n=0"
    if len(xs) < 4:
        return "%.1f n=%d" % (st.median(xs), len(xs))
    a, _, c = st.quantiles(xs, n=4)
    return "%.1f [%.1f-%.1f] n=%d" % (st.median(xs), a, c, len(xs))


def pct(xs):
    return "%.0f%% n=%d" % (100.0 * sum(xs) / len(xs), len(xs)) if xs else "n=0"


res = collections.defaultdict(lambda: collections.defaultdict(list))
games = 0
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    info = d["info"]; c = info["config"]
    T = terrain(c["gameMap"], c["gameMapSize"])
    if T is None or not info.get("winner"):
        continue
    W = T[0]
    xy = lambda tile: (tile % W, tile // W)
    win = info["winner"][1]
    games += 1
    t_end = d["turns"][-1]["turnNumber"] / 10
    builds = collections.defaultdict(list)   # cid -> [(t, (x, y), unit)]
    spawn = {}
    launches = []                            # (t, launcher, (x, y))
    attacks = collections.defaultdict(list)  # cid -> [t]
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            ty, cid = it.get("type"), it.get("clientID")
            if ty == "spawn":
                spawn[cid] = (t, xy(int(it["tile"])))
            elif ty == "build_unit":
                u = it["unit"]
                if it.get("tile") is None:
                    continue
                if u in NUKES:
                    launches.append((t, cid, xy(int(it["tile"]))))
                else:
                    builds[cid].append((t, xy(int(it["tile"])), u))
            elif ty == "attack":
                attacks[cid].append(t)
    launches.sort()
    hits = collections.defaultdict(list)     # victim -> [(t, launcher)]
    for t, launcher, (tx, ty) in launches:
        for p in set(builds) | set(spawn):
            if p == launcher:
                continue
            pts = [pt for bt, pt, bu in builds.get(p, []) if bt <= t]
            if p in spawn and spawn[p][0] <= t:
                pts.append(spawn[p][1])
            if any(max(abs(tx - x), abs(ty - y)) <= R for x, y in pts):
                hits[p].append((t, launcher))
    for p, ev in hits.items():
        g = "W" if p == win else "R"
        t0 = ev[0][0]
        m = res[g]
        sams = sorted(bt for bt, _, bu in builds.get(p, []) if bu == "SAM Launcher")
        before = [s for s in sams if s <= t0]
        m["hits"].append(len(ev))
        m["t0"].append(t0)
        m["sam_owned_before"].append(len(before))
        m["sam_pre"].append(int(any(t0 - PRE <= s <= t0 for s in sams)))
        m["sam_post"].append(int(any(t0 < s <= t0 + POST for s in sams)))
        m["sam_lead"].append(t0 - before[0] if before else None)
        m["nuke_post"].append(int(any(l == p and t0 <= lt <= t0 + POST for lt, l, _ in launches)))
        m["atk30"].append(int(any(t0 <= a <= t0 + 30 for a in attacks.get(p, []))))
        m["atk60"].append(int(any(t0 <= a <= t0 + POST for a in attacks.get(p, []))))
        wins = [s for s in range(int(t0), int(t_end) - 30, 30)]
        base = [int(any(s <= a < s + 30 for a in attacks.get(p, []))) for s in wins]
        m["atk_base30"].append(sum(base) / len(base) if base else None)
        own = [lt for lt, l, _ in launches if l == p]
        nw = [s for s in range(int(t0), int(t_end) - 60, 60)]
        m["nuke_base60"].append(sum(int(any(s <= x < s + 60 for x in own)) for s in nw) / len(nw) if nw else None)

print("games with nuke data:", games)
for g, label in (("W", "winners"), ("R", "other hit players")):
    m = res[g]
    print("%s (n=%d): launches received per hit player %s | first hit at %s s"
          % (label, len(m["hits"]), q(m["hits"]), q(m["t0"])))
    print("  SAM in %ds before first hit %s | SAM in %ds after %s | SAMs owned before first hit %s"
          % (PRE, pct(m["sam_pre"]), POST, pct(m["sam_post"]), q(m["sam_owned_before"])))
    print("  SAM lead (s, first SAM before first hit, if any) %s" % q(m["sam_lead"]))
    print("  own nuke launched within %ds %s | own attack within 30 s %s | within %ds %s | base attack rate per 30 s after hit %s | base own-nuke rate per 60 s after hit %s"
          % (POST, pct(m["nuke_post"]), pct(m["atk30"]), POST, pct(m["atk60"]), q(m["atk_base30"]), q(m["nuke_base60"])))
