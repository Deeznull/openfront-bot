"""Conditional tactic check (ORCH amendment): when does each tactic work, split by condition.
Per player-game features (intents only, 146 default 30+ FFA games), split into cells:
  coast   : spawn tile has water within 3 tiles (map.bin, land bit 7)
  nation  : a Nation spawn (manifest coordinates) within 80 tiles of the spawn
  human   : another human spawn within 80 tiles of the spawn
  map     : map name (cells with < 3 GOOD and < 3 BAD player-games are not verdicts)
GOOD = top 10% by final rank, BAD = rank > ceil(N/2). Gold is not in the intents: not split.
A cell gets a verdict only with >= 3 GOOD and >= 3 BAD player-games; otherwise [unknown, n=X].
Writes out/tactic_conditions.md. Run: python -I tactic_conditions.py"""
import csv, json, math, os, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse  # noqa: E402

MAPS = os.path.join(TOOLS, "OpenFrontIO", "resources", "maps")
NEAR = 80
MIN_CASES = 3
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0]
_maps = {}


def map_info(name):
    key = "".join(ch for ch in name.lower() if ch.isalnum())
    if key not in _maps:
        m = json.load(open(os.path.join(MAPS, key, "manifest.json"), encoding="utf-8"))
        w, h = m["map"]["width"], m["map"]["height"]
        terr = open(os.path.join(MAPS, key, "map.bin"), "rb").read()
        nations = [tuple(n["coordinates"]) for n in m.get("nations", []) if n.get("coordinates")]
        _maps[key] = (w, h, terr, nations)
    return _maps[key]


def coastal(x, y, w, h, terr):
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            xx, yy = x + dx, y + dy
            if 0 <= xx < w and 0 <= yy < h and not (terr[yy * w + xx] & 0x80):
                return True
    return False


# feature name -> function(player dict, t_spawn) -> bool
def cnt(p, unit):
    return sum(1 for _, u in p["builds"] if u == unit)


def first(p, unit):
    ts = [t for t, u in p["builds"] if u == unit]
    return min(ts) if ts else None


FEATURES = {
    "allreq_by120":  lambda p: sum(1 for t, *_ in p["req"] if t <= 120) >= 2,
    "boat_by120":    lambda p: any(t <= 120 for t, _ in p["boats"]),
    "extension":     lambda p: len(p["ext"]) >= 1,
    "warship":       lambda p: cnt(p, "Warship") >= 1,
    "sam":           lambda p: cnt(p, "SAM Launcher") >= 1,
    "mirv":          lambda p: cnt(p, "MIRV") >= 1,
    "defpost_by200": lambda p: (first(p, "Defense Post") or 1e9) <= 200,
    "attacks_nation": lambda p: any(a[2] == "nation" for a in p["attacks"]),
    "attacks_bot":   lambda p: any(a[2] == "bot" for a in p["attacks"]),
    "alliance_break": lambda p: len(p["brk"]) >= 1,
}

# (feature, cell kind) -> counts[(cellvalue, group)][outcome]
data = []  # rows: dict(map, grp, coast, nation, human, feat -> bool)
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
    w, h, terr, nations = map_info(g["map"])
    spawn = {}
    for turn in d["turns"]:
        for it in turn["intents"]:
            if it.get("type") == "spawn" and it.get("clientID") is not None:
                spawn[it["clientID"]] = (it["tile"] % w, it["tile"] // w)
    for p in g["players"]:
        grp = "GOOD" if p["rank"] <= good_max else ("BAD" if p["rank"] >= bad_min else None)
        if grp is None or p["cid"] not in spawn:
            continue
        sx, sy = spawn[p["cid"]]
        near_nat = any(math.hypot(sx - nx, sy - ny) <= NEAR for nx, ny in nations)
        near_hum = any(math.hypot(sx - ox, sy - oy) <= NEAR
                       for c, (ox, oy) in spawn.items() if c != p["cid"])
        row = dict(map=g["map"], grp=grp,
                   coast="coastal" if coastal(sx, sy, w, h, terr) else "inland",
                   nation=("Nation within 80" if near_nat else "no Nation within 80"),
                   human=("human within 80" if near_hum else "no human within 80"))
        for f, fn in FEATURES.items():
            row[f] = bool(fn(p))
        data.append(row)


def verdict(cell_rows, feat):
    g_rows = [x for x in cell_rows if x["grp"] == "GOOD"]
    b_rows = [x for x in cell_rows if x["grp"] == "BAD"]
    ng, nb = len(g_rows), len(b_rows)
    if ng < MIN_CASES or nb < MIN_CASES:
        return "[unknown, n=%d GOOD / %d BAD]" % (ng, nb)
    gs = 100 * sum(x[feat] for x in g_rows) / ng
    bs = 100 * sum(x[feat] for x in b_rows) / nb
    diff = gs - bs
    tag = "✓" if diff >= 15 else ("✗" if diff <= -15 else "~none")
    return "%s GOOD %.0f%% vs BAD %.0f%% (n=%d/%d)" % (tag, gs, bs, ng, nb)


CELLS = [("coast", ["coastal", "inland"]),
         ("nation", ["Nation within 80", "no Nation within 80"]),
         ("human", ["human within 80", "no human within 80"])]
maps = sorted({x["map"] for x in data})
out_lines = ["# Conditional tactic check (146 games; player-games = %d)" % len(data),
             "Verdict per cell: ✓ GOOD share ≥15 points higher, ✗ ≥15 points lower, ~none within 15; "
             "[unknown] if fewer than 3 GOOD or 3 BAD player-games in the cell.", ""]
for f in FEATURES:
    out_lines.append("## " + f)
    for ckey, vals in CELLS:
        for v in vals:
            cell = [x for x in data if x[ckey] == v]
            out_lines.append("- %s = %s: %s" % (ckey, v, verdict(cell, f)))
    for m in maps:
        cell = [x for x in data if x["map"] == m]
        if sum(1 for x in cell if x["grp"] == "GOOD") >= MIN_CASES and sum(1 for x in cell if x["grp"] == "BAD") >= MIN_CASES:
            out_lines.append("- map = %s: %s" % (m, verdict(cell, f)))
    out_lines.append("")

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
text = "\n".join(out_lines)
open(os.path.join(HERE, "out", "tactic_conditions.md"), "w", encoding="utf-8").write(text + "\n")
print("games %d, player-games %d; wrote out/tactic_conditions.md" % (games, len(data)))
