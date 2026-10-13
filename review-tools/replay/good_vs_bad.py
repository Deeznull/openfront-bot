"""Good vs bad players, first 5 minutes, from intents only (146 default 30+ FFA games).
GOOD = top 10% by final rank in the game (rank <= ceil(0.10 * N)), winner included.
BAD  = bottom half by final rank (rank > ceil(N / 2)), which includes early deaths.
N = spawned players + winner (load.parse). Window = game seconds 0-300.
Per player: actions/min (all intents except spawn), attacks/min, mean send (display = raw / 10),
time to first attack / boat / City, distinct attack targets, boats, alliance requests,
idle gaps > 15 s (gaps between consecutive actions, with 0 and 300 s as edges).
Send size as % of troops is NOT computed: it needs a troop time series (engine re-sim is out of sync
after ~36-90 s). Run: python -I good_vs_bad.py"""
import csv, json, math, os, statistics as st, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse  # noqa: E402

WIN = 300.0
GAP = 15.0
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0]

out = []
games = 0
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    g = parse(d)
    if g is None:
        continue
    games += 1
    N = len(g["players"])
    good_max = math.ceil(0.10 * N)
    bad_min = math.ceil(N / 2) + 1
    rank_of = {p["cid"]: p["rank"] for p in g["players"]}
    group_of = {}
    for p in g["players"]:
        if p["rank"] <= good_max:
            group_of[p["cid"]] = "GOOD"
        elif p["rank"] >= bad_min:
            group_of[p["cid"]] = "BAD"

    ev = collections.defaultdict(list)  # cid -> [(t, type, extra)]
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        if t >= WIN:
            break
        for it in turn["intents"]:
            cid = it.get("clientID")
            if cid in group_of:
                ev[cid].append((t, it.get("type"), it))

    for cid, grp in group_of.items():
        acts = [e for e in ev[cid] if e[1] != "spawn"]
        atk = [e for e in acts if e[1] == "attack"]
        boats = [e for e in acts if e[1] == "boat"]
        cities = [e[0] for e in acts if e[1] == "build_unit" and e[2].get("unit") == "City"]
        reqs = [e for e in acts if e[1] == "allianceRequest"]
        times = sorted(e[0] for e in acts)
        edges = [0.0] + times + [WIN]
        gaps = sum(1 for a, b in zip(edges, edges[1:]) if b - a > GAP)
        sends = [float(e[2].get("troops", 0)) / 10 for e in atk if e[2].get("troops") is not None]
        out.append(dict(
            game=g["gid"], group=grp, map=g["map"], n=N, rank=rank_of[cid],
            actions_min=len(acts) / 5, attacks_min=len(atk) / 5,
            send_mean=(st.mean(sends) if sends else None),
            t_first_attack=(atk[0][0] if atk else None),
            t_first_boat=(boats[0][0] if boats else None),
            t_first_city=(min(cities) if cities else None),
            distinct_targets=len({e[2].get("targetID") for e in atk}),
            boats=len(boats), alliance_req=len(reqs), idle_gaps=gaps,
        ))


def med(vals):
    vals = [v for v in vals if v is not None]
    return ("%.2f" % st.median(vals)) if vals else "n=0"


metrics = ["actions_min", "attacks_min", "send_mean", "t_first_attack", "t_first_boat", "t_first_city",
           "distinct_targets", "boats", "alliance_req", "idle_gaps"]
print("games %d, player rows %d" % (games, len(out)))
for grp in ("GOOD", "BAD"):
    sub = [o for o in out if o["group"] == grp]
    print(grp, "n=%d" % len(sub), {m: med([o[m] for o in sub]) for m in metrics})
    print("   no first attack %.0f%%, no boat %.0f%%, no City %.0f%%" % (
        100 * sum(o["t_first_attack"] is None for o in sub) / max(1, len(sub)),
        100 * sum(o["t_first_boat"] is None for o in sub) / max(1, len(sub)),
        100 * sum(o["t_first_city"] is None for o in sub) / max(1, len(sub))))
    print("   share with >=1 idle gap: %.0f%%" % (100 * sum(o["idle_gaps"] > 0 for o in sub) / max(1, len(sub))))

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
with open(os.path.join(HERE, "out", "good_vs_bad.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)
