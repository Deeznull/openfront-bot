"""Reads the re-simulation snapshots (out/resim/<gameID>.json from tests/replay/Resim.ts)
and the matching records, and reports:
  - sync: last turn where recomputed hashes match the record (trust window)
  - benchmarks at 1:00 / 3:00 / 6:00: winner land % and troop % (display = raw / 10), top-tile player
  - step 3: Nations within 80 tiles (Euclidean, from Nation spawn cells) of the winner's spawn, and
    whether the winner attacked or requested alliance with them (record intents, smallID targets)
  - step 4: games where the #1 by tiles at 3:00 was not the winner (only trusted inside the sync window)
Run: python -I resim_report.py [outDir]   (default out/resim)
Tile refs: x = ref % width, y = ref // width, width from resources/maps/<key>/manifest.json."""
import glob, json, math, os, statistics as st, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out", "resim")
ENGINE_MAPS = os.path.join(TOOLS, "OpenFrontIO", "resources", "maps")
MARKS = (60, 180, 360)
NEAR = 80.0

width_cache = {}


def width_of(map_name):
    key = "".join(ch for ch in map_name.lower() if ch.isalnum())  # "Gulf of St. Lawrence" -> gulfofstlawrence
    if key not in width_cache:
        m = json.load(open(os.path.join(ENGINE_MAPS, key, "manifest.json"), encoding="utf-8"))
        width_cache[key] = m["map"]["width"]
    return width_cache[key]


def at(samples, t):
    """Latest sample at or before game second t."""
    best = None
    for s in samples:
        if s["turn"] <= t * 10:
            best = s
    return best


rows = []
sync_turns = []
for path in sorted(glob.glob(os.path.join(OUT, "*.json"))):
    d = json.load(open(path, encoding="utf-8"))
    if d.get("failed") or not d["samples"]:
        continue
    hs = d["hashes"]
    # trusted window: first hash mismatch (or end of run if none)
    sync_s = (hs["firstMismatch"] / 10) if hs["firstMismatch"] is not None else None
    sync_turns.append(sync_s if sync_s is not None else float("inf"))
    win_cid = (d["winner"] or [None, None])[1]
    land = d["numLandTiles"] or 1
    row = {"game": d["gameID"], "map": d["map"], "sync_s": sync_s, "winner_cid": win_cid}

    # benchmarks
    for m in MARKS:
        s = at(d["samples"], m)
        if s is None:
            continue
        alive = [p for p in s["players"] if p["alive"]]
        w = next((p for p in alive if p["clientID"] == win_cid), None)
        top = max(alive, key=lambda p: p["tiles"]) if alive else None
        row[f"w_land_{m}"] = 100.0 * w["tiles"] / land if w else None
        row[f"w_troop_{m}"] = w["troops"] / 10 if w else None
        row[f"top_is_winner_{m}"] = (top is not None and w is not None and top["smallID"] == w["smallID"])
        row[f"top_land_{m}"] = 100.0 * top["tiles"] / land if top else None

    # step 3: nation neighbours of the winner's spawn
    rec = json.load(open(os.path.join(TOOLS, "replays", d["gameID"] + ".json"), encoding="utf-8")) \
        if os.path.exists(os.path.join(TOOLS, "replays", d["gameID"] + ".json")) else None
    if rec is None:
        alt = os.path.join(TOOLS, "replays_world", d["gameID"] + ".json")
        rec = json.load(open(alt, encoding="utf-8")) if os.path.exists(alt) else None
    spawn = None
    attacked_nations = 0
    requested_nations = 0
    nation_smallids = {p["smallID"]: p["name"] for s in d["samples"] for p in s["players"]
                       if p["type"].upper().endswith("NATION")}
    if rec is not None:
        w = width_of(d["map"])
        for t in rec["turns"]:
            for it in t["intents"]:
                if it.get("type") == "spawn" and it.get("clientID") == win_cid and spawn is None:
                    spawn = (it["tile"] % w, it["tile"] // w)
                if it.get("type") == "attack" and it.get("clientID") == win_cid \
                        and it.get("targetID") in nation_smallids:
                    attacked_nations += 1
    near = []
    if spawn is not None:
        for n in d["nationSpawns"]:
            if n["x"] is None:
                continue
            dist = math.hypot(n["x"] - spawn[0], n["y"] - spawn[1])
            if dist <= NEAR:
                near.append((n["name"], round(dist)))
    row["nations_within_80"] = len(near)
    row["near_names"] = near[:8]
    row["winner_attacks_on_nations"] = attacked_nations
    rows.append(row)


def med(xs):
    xs = [x for x in xs if x is not None]
    return ("%.2f" % st.median(xs)) if xs else "n=0"


print("games reported: %d" % len(rows))
finite = [x for x in sync_turns if x != float("inf")]
print("sync: first hash mismatch in %d/%d games; median first mismatch %s s; "
      "games in sync to 60 s: %d, to 180 s: %d, to 360 s: %d" % (
          len(finite), len(sync_turns), med(finite),
          sum(1 for r in rows if r["sync_s"] is None or r["sync_s"] >= 60),
          sum(1 for r in rows if r["sync_s"] is None or r["sync_s"] >= 180),
          sum(1 for r in rows if r["sync_s"] is None or r["sync_s"] >= 360)))
for m in MARKS:
    print("%d:00 winner land %% median %s, winner troop (display) median %s, winner is #1 by tiles in %s of games" % (
        m // 60, med([r.get("w_land_%d" % m) for r in rows]), med([r.get("w_troop_%d" % m) for r in rows]),
        sum(1 for r in rows if r.get("top_is_winner_%d" % m)), ))
print("step 3: nations within 80 tiles of winner spawn: median %s, games with >=1: %d/%d" % (
    med([r["nations_within_80"] for r in rows]), sum(1 for r in rows if r["nations_within_80"] > 0), len(rows)))
print("step 3: winner attacks on Nations (intents): median %s" % med([r["winner_attacks_on_nations"] for r in rows]))
print("step 4 candidates (#1 at 3:00 not the winner):")
cands = [r for r in rows if r.get("top_is_winner_180") is False]
for r in cands[:10]:
    print("  %s %s sync %s s, #1 land %s%%, winner land %s%%" % (
        r["game"], r["map"], r["sync_s"], med([r.get("top_land_180")]), med([r.get("w_land_180")])))
json.dump(rows, open(os.path.join(HERE, "out", "resim_rows.json"), "w", encoding="utf-8"), indent=1)
