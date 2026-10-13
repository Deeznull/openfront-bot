"""Benchmarks at 1:00 / 3:00 / 6:00 for default 30+ FFA winners vs others, from intents only.
Per player, cumulative counts up to each mark: City builds, boats sent, attacks sent, alliance requests sent.
Not in the data: land %, troop %, #1 ranking by time (no tile or troop time series).
Run: python -I benchmarks.py [world|full|both]  (default both)"""
import csv, json, os, sys, statistics as st, collections

SRC = sys.argv[1] if len(sys.argv) > 1 else "both"
MARKS = (60, 180, 360)

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0 and (SRC == "both" or r["src"] == SRC)]


def med(xs):
    return "%.1f" % st.median(xs) if xs else "n=0"


res = collections.defaultdict(lambda: collections.defaultdict(list))
games = 0
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    info = d["info"]
    win = (info.get("winner") or [None, None])[1]
    if win is None:
        continue
    games += 1
    ev = collections.defaultdict(lambda: collections.defaultdict(list))  # cid -> kind -> [t]
    seen = set()
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            cid, ty = it.get("clientID"), it.get("type")
            if cid:
                seen.add(cid)
            if ty == "build_unit" and it.get("unit") == "City":
                ev[cid]["city"].append(t)
            elif ty == "boat":
                ev[cid]["boat"].append(t)
            elif ty == "attack":
                ev[cid]["atk"].append(t)
            elif ty == "allianceRequest":
                ev[cid]["req"].append(t)
    for p in seen:
        g = "W" if p == win else "O"
        for m in MARKS:
            for kind in ("city", "boat", "atk", "req"):
                res[(g, m)][kind].append(sum(1 for t in ev[p][kind] if t <= m))

print("games with a winner: %d (src=%s)" % (games, SRC))
for g, label in (("W", "winners"), ("O", "others")):
    for m in MARKS:
        k = res[(g, m)]
        n = len(k["city"])
        print("%-8s %d:00  n=%d  Cities %s | boats %s | attacks %s | alliance requests %s" % (
            label, m // 60, n, med(k["city"]), med(k["boat"]), med(k["atk"]), med(k["req"])))
