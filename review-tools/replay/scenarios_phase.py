"""Phase scenario rows from intents (146 default 30+ FFA games).
A) First 60 s: actions per 10 s window (0-10, 10-20, ... 50-60) for GOOD (top 10%) and BAD (rank > ceil(N/2)).
   Actions = attack, build_unit, boat, allianceRequest, upgrade_structure, cancel_attack.
B) Boxed by Nations, 1:00-3:00: proxy = a Nation (manifest coordinates) within 80 tiles of your spawn,
   and no attack on wilderness (wild) in 60-180 s. Responses in 60-180 s: attacks on Nations, boats,
   alliance requests, Port/Factory/City builds, and total attacks.
Intents only; Nation attacks on you are not in intents, so 'boxed' is a proxy.
Writes out/scenarios_phase.csv. Run: python -I scenarios_phase.py"""
import csv, json, math, os, sys, collections, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse  # noqa: E402

MAPS = os.path.join(TOOLS, "OpenFrontIO", "resources", "maps")
NEAR = 80
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0]
_maps = {}


def map_nations(name):
    key = "".join(ch for ch in name.lower() if ch.isalnum())
    if key not in _maps:
        m = json.load(open(os.path.join(MAPS, key, "manifest.json"), encoding="utf-8"))
        w = m["map"]["width"]
        _maps[key] = (w, [tuple(n["coordinates"]) for n in m.get("nations", []) if n.get("coordinates")])
    return _maps[key]


ACTIONS = {"attack", "build_unit", "boat", "allianceRequest", "upgrade_structure", "cancel_attack"}
A_bins = collections.defaultdict(lambda: collections.defaultdict(list))  # grp -> bin -> list of counts
B = collections.defaultdict(collections.Counter)  # grp -> counter
B_n = collections.Counter()
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
    W, nations = map_nations(g["map"])
    cid2p = {p["cid"]: p for p in g["players"]}
    grp = {p["cid"]: ("GOOD" if p["rank"] <= good_max else ("BAD" if p["rank"] >= bad_min else None))
           for p in g["players"]}
    spawn = {}
    ev = collections.defaultdict(list)  # cid -> list of (t, kind, target_class/unit)
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            cid = it.get("clientID")
            if it.get("type") == "spawn" and cid is not None:
                spawn[cid] = (it["tile"] % W, it["tile"] // W)
            if cid not in cid2p:
                continue
            ty = it.get("type")
            if ty == "attack":
                ev[cid].append((t, "attack", it.get("targetID")))
            elif ty == "build_unit":
                ev[cid].append((t, "build", it.get("unit")))
            elif ty == "boat":
                ev[cid].append((t, "boat", None))
            elif ty == "allianceRequest":
                ev[cid].append((t, "req", it.get("recipient")))
            elif ty in ("upgrade_structure", "cancel_attack"):
                ev[cid].append((t, ty, None))

    # class of attack target: wild / bot / nation / human, via parse's cls
    def tcls(tid):
        return g["cls"](tid)

    for cid, p in cid2p.items():
        gr = grp.get(cid)
        if gr is None:
            continue
        evs = ev.get(cid, [])
        # A) actions per 10 s, first 60 s
        for b0 in range(0, 60, 10):
            n = sum(1 for t, k, _ in evs if b0 <= t < b0 + 10 and k in ("attack", "build", "boat", "req", "upgrade_structure", "cancel_attack"))
            A_bins[gr][b0].append(n)
        # B) boxed proxy
        s = spawn.get(cid)
        if s is None:
            continue
        near_nat = any(math.hypot(s[0] - nx, s[1] - ny) <= NEAR for nx, ny in nations)
        if not near_nat:
            continue
        wild_1_3 = [(t, tid) for t, k, tid in evs if k == "attack" and 60 <= t < 180 and tcls(tid) == "wild"]
        boxed = len(wild_1_3) == 0
        key = "boxed" if boxed else "free"
        B_n[(gr, key)] += 1
        win = [(t, k, x) for t, k, x in evs if 60 <= t < 180]
        c = B[(gr, key)]
        if any(k == "attack" and tcls(x) == "nation" for _, k, x in win):
            c["attack_nation"] += 1
        if any(k == "boat" for _, k, _ in win):
            c["boat"] += 1
        if any(k == "req" for _, k, _ in win):
            c["alliance_req"] += 1
        if any(k == "build" and x in ("Port", "Factory", "City") for _, k, x in win):
            c["port_factory_city"] += 1
        c["attacks_total"] += sum(1 for _, k, _ in win if k == "attack")

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
with open(os.path.join(HERE, "out", "scenarios_phase.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["section", "group", "key", "n", "metric", "value"])
    print("games %d" % games)
    print("A) actions per 10 s, median (n player-games)")
    for gr in ("GOOD", "BAD"):
        line = []
        for b0 in range(0, 60, 10):
            vals = A_bins[gr][b0]
            m = st.median(vals) if vals else 0
            mean = st.mean(vals) if vals else 0
            line.append("%d-%ds med %.0f mean %.2f" % (b0, b0 + 10, m, mean))
            w.writerow(["A", gr, "%d-%d s" % (b0, b0 + 10), len(vals), "mean_actions", "%.2f" % mean])
        print(" %s: %s" % (gr, " | ".join(line)))
    print("B) boxed-by-Nation proxy, 1:00-3:00 (Nation within 80 tiles of spawn; boxed = no wild attack in 60-180 s)")
    for (gr, key), n in sorted(B_n.items()):
        c = B[(gr, key)]
        parts = ", ".join("%s %.0f%%" % (k, 100 * c[k] / n) for k in
                          ["attack_nation", "boat", "alliance_req", "port_factory_city"])
        print(" %s %s n=%d: %s; attacks/player mean %.1f" % (gr, key, n, parts, c["attacks_total"] / max(1, n)))
        for k in ["attack_nation", "boat", "alliance_req", "port_factory_city"]:
            w.writerow(["B", gr, key, n, k, "%.1f%%" % (100 * c[k] / n)])
        w.writerow(["B", gr, key, n, "attacks_mean", "%.1f" % (c["attacks_total"] / max(1, n))])
