"""Opening timings for winners vs other players, default 30+ FFA, tools/replays_world (out/ffa30_index.csv, src=world).
Per player: first attack, first boat, first City build, Cities built by 60 s and 180 s, attacks by 180 s.
Land % at 1:00 and 3:00 and 'first Tribe' are NOT in the replay data (intents only, no tile ownership, no tribe action).
Run: python -I opening.py [world|full]  (default world; full = tools/replays)"""
import csv, json, os, sys, statistics as st, collections

SRC = sys.argv[1] if len(sys.argv) > 1 else "world"

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if r["src"] == SRC and int(r["turns"] or 0) > 0]


def med(xs):
    xs = [x for x in xs if x is not None]
    return "%.0f n=%d" % (st.median(xs), len(xs)) if xs else "n=0"


def share(xs):
    xs = [x for x in xs if x is not None]
    return "%.0f%%" % (100.0 * sum(xs) / len(xs)) if xs else "n=0"


res = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    info = d["info"]
    win = (info.get("winner") or [None, None])[1]
    if win is None:
        continue
    first = {}
    city = collections.defaultdict(list)
    atk = collections.defaultdict(list)
    boat = {}
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            cid, ty = it.get("clientID"), it.get("type")
            if ty == "attack":
                atk[cid].append(t)
                first.setdefault(("atk", cid), t)
            elif ty == "boat":
                first.setdefault(("boat", cid), t)
            elif ty == "build_unit" and it.get("unit") == "City":
                city[cid].append(t)
    players = set(c for _, c in first) | set(atk) | set(city)
    for p in players:
        g = "W" if p == win else "O"
        m = res[g]
        m["first_attack"].append(first.get(("atk", p)))
        m["first_boat"].append(first.get(("boat", p)))
        m["first_city"].append(min(city[p]) if city[p] else None)
        m["city_60"].append(sum(1 for t in city[p] if t <= 60))
        m["city_180"].append(sum(1 for t in city[p] if t <= 180))
        m["atk_180"].append(sum(1 for t in atk[p] if t <= 180))
        m["boat_by_60"].append(1 if (("boat", p) in first and first[("boat", p)] <= 60) else 0)

for g, label in (("W", "winners"), ("O", "others")):
    m = res[g]
    print("[%s] %s: first attack %s s | first boat %s s (boat by 60 s %s) | first City %s s" % (
        SRC, label, med(m["first_attack"]), med(m["first_boat"]), share(m["boat_by_60"]), med(m["first_city"])))
    print("   Cities built by 60 s %s, by 180 s %s | attacks by 180 s %s" % (
        med(m["city_60"]), med(m["city_180"]), med(m["atk_180"])))
