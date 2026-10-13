"""First boat and first attack timing of the WINNERS in default 30+ FFA games from tools/replays_world.
Uses out/ffa30_index.csv (src=world) and tools/load.py parse() (data only). Times in game seconds (turn/10).
Run: python -I tools/replay_tools/timing.py"""
import csv, json, os, sys, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse


def q(xs):
    xs = sorted(xs)
    if not xs:
        return "n=0"
    qs = st.quantiles(xs, n=4) if len(xs) >= 4 else [xs[0], xs[0], xs[-1]]
    return "%.1f s [%.1f-%.1f] n=%d" % (st.median(xs), qs[0], qs[2], len(xs))


rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if r["src"] == "world" and int(r["turns"] or 0) > 0]
boat, atk, boat_by_map, atk_by_map = [], [], collections.defaultdict(list), collections.defaultdict(list)
n_games = 0
no_boat = 0
for r in rows:
    g = parse(json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8")))
    if not g:
        continue
    n_games += 1
    w = g["winner"]
    if w["attacks"]:
        atk.append(w["attacks"][0][0])
        atk_by_map[g["map"]].append(w["attacks"][0][0])
    if w["boats"]:
        boat.append(w["boats"][0][0])
        boat_by_map[g["map"]].append(w["boats"][0][0])
    else:
        no_boat += 1
print("games", n_games, "| winners with no boat", no_boat)
print("first attack:", q(atk))
print("first boat:", q(boat))
for m, _ in collections.Counter({k: len(v) for k, v in boat_by_map.items()}).most_common(3):
    print("  %s: boat %s | attack %s" % (m, q(boat_by_map[m]), q(atk_by_map[m])))
