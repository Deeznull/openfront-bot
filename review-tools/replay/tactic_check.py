"""Per-player whole-game features for tactic validation (146 default 30+ FFA games).
GOOD = top 10% by final rank (rank <= ceil(0.10 * N)); BAD = rank > ceil(N / 2).
Features come from intents only (load.parse + raw spawn tiles):
  MIRV / nuke / SAM / Defense Post / silo / port / warship / City builds (count, first time),
  boat intents, attacks by target class (bot / nation / wild / human), alliance breaks, extensions,
  alliance requests, nearest other human spawn (tiles, Euclidean).
Intent counts are NOT completed structures or landings (boats are capped at 3 in flight).
Run: python -I tactic_check.py"""
import csv, json, math, os, statistics as st, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse  # noqa: E402

ENGINE_MAPS = os.path.join(TOOLS, "OpenFrontIO", "resources", "maps")
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0]
width_cache = {}


def width_of(map_name):
    key = "".join(ch for ch in map_name.lower() if ch.isalnum())  # "Gulf of St. Lawrence" -> gulfofstlawrence
    if key not in width_cache:
        m = json.load(open(os.path.join(ENGINE_MAPS, key, "manifest.json"), encoding="utf-8"))
        width_cache[key] = m["map"]["width"]
    return width_cache[key]


out = []
unit_names = collections.Counter()
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
    W = width_of(g["map"])

    # raw spawn tiles (parse keeps times only)
    spawn_tile = {}
    for turn in d["turns"]:
        for it in turn["intents"]:
            if it.get("type") == "spawn" and it.get("clientID") is not None:
                spawn_tile[it["clientID"]] = it["tile"]  # last spawn wins (re-picks)
    humans = {cid: (t % W, t // W) for cid, t in spawn_tile.items()}

    for p in g["players"]:
        grp = "GOOD" if p["rank"] <= good_max else ("BAD" if p["rank"] >= bad_min else None)
        if grp is None:
            continue
        b = p["builds"]
        for _, u in b:
            unit_names[u] += 1

        def first(unit):
            ts = [t for t, u in b if u == unit]
            return min(ts) if ts else None

        def count(unit):
            return sum(1 for _, u in b if u == unit)

        cx = humans.get(p["cid"])
        near = None
        if cx is not None:
            ds = [math.hypot(cx[0] - o[0], cx[1] - o[1]) for c, o in humans.items() if c != p["cid"]]
            near = min(ds) if ds else None
        atk = p["attacks"]
        out.append(dict(
            game=g["gid"], map=g["map"], n=N, rank=p["rank"], group=grp,
            mirv=count("MIRV"), mirv_first=first("MIRV"),
            nukes=count("Atom Bomb") + count("Hydrogen Bomb"),
            sam=count("SAM Launcher"), sam_first=first("SAM Launcher"),
            defense_post=count("Defense Post"), dp_first=first("Defense Post"),
            silo=count("Missile Silo"), port=count("Port"), warship=count("Warship"), city=count("City"),
            boats=len(p["boats"]),
            atk_total=len(atk),
            atk_bot=sum(1 for a in atk if a[2] == "bot"),
            atk_nation=sum(1 for a in atk if a[2] == "nation"),
            atk_wild=sum(1 for a in atk if a[2] == "wild"),
            atk_human=sum(1 for a in atk if a[2] == "human"),
            breaks=len(p["brk"]), breaks_human=sum(1 for x in p["brk"] if x[2] == "human"),
            brk_first=(min(x[0] for x in p["brk"]) if p["brk"] else None),
            brk_last=(max(x[0] for x in p["brk"]) if p["brk"] else None),
            extensions=len(p["ext"]), alliance_req=len(p["req"]),
            nearest_spawn=near,
        ))


def med(vals):
    vals = [v for v in vals if v is not None]
    return ("%.1f" % st.median(vals)) if vals else "n=0"


def share(vals):
    return ("%.0f%%" % (100 * sum(1 for v in vals if v) / max(1, len(vals))))


print("games %d, player rows %d" % (games, len(out)))
print("build unit names seen:", dict(unit_names.most_common()))
feats = ["mirv", "mirv_first", "nukes", "sam", "sam_first", "defense_post", "dp_first", "silo", "port",
         "warship", "city", "boats", "atk_total", "atk_bot", "atk_nation", "atk_wild", "atk_human",
         "breaks", "breaks_human", "brk_first", "brk_last", "extensions", "alliance_req", "nearest_spawn"]
for f in feats:
    gv = [o[f] for o in out if o["group"] == "GOOD"]
    bv = [o[f] for o in out if o["group"] == "BAD"]
    if f.endswith("_first") or f.endswith("_last") or f == "nearest_spawn":
        print("%-14s median  GOOD %s (n=%d)  BAD %s (n=%d)" % (f, med(gv), len([v for v in gv if v is not None]),
                                                                 med(bv), len([v for v in bv if v is not None])))
    else:
        print("%-14s median  GOOD %s  BAD %s  | >=1: GOOD %s BAD %s" % (
            f, med(gv), med(bv), share(gv), share(bv)))

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
with open(os.path.join(HERE, "out", "tactic_check.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)
