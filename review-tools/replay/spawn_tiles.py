"""Spawn tiles for the 30+ default FFA batch (rows from out/ffa30_index.csv).
Sources: full replays (spawn intents: tile, clientID, turn/10 s) and slim files (spawns: [sec, tile, cid]).
Tile -> (x, y) with width from tools/maps/<key>_manifest.json (Normal = map, Compact = map4x), terrain from <key>_map(4x).z.
Coast = yes if any ocean tile (terrain bit5) lies within 3 tiles. Terrain byte: bit7 land, bit5 ocean (spawn_atlas.py).
Full replays: each player's final spawn pick only (re-picks are dropped). Writes out/spawns.csv (one row per spawn) and prints counts. Run: python -I tools/replay_tools/spawn_tiles.py"""
import csv, json, os, re, zlib, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
MAPS = os.path.join(TOOLS, "maps")
INDEX = os.path.join(HERE, "out", "ffa30_index.csv")
OUT = os.path.join(HERE, "out", "spawns.csv")
key = lambda n: re.sub(r"[^a-z0-9]", "", (n or "").lower())
_cache = {}


def terrain(mapname, size):
    k = (key(mapname), size)
    if k in _cache:
        return _cache[k]
    variant = "map4x" if size == "Compact" else "map"
    mf = os.path.join(MAPS, "%s_manifest.json" % key(mapname))
    bf = os.path.join(MAPS, "%s_%s.z" % (key(mapname), variant))
    if not (os.path.exists(mf) and os.path.exists(bf)):
        _cache[k] = None
        return None
    m = json.load(open(mf, encoding="utf-8"))[variant]
    w, h = m["width"], m["height"]
    raw = zlib.decompress(open(bf, "rb").read())
    if len(raw) != w * h:
        _cache[k] = None
        return None
    _cache[k] = (w, h, raw)
    return _cache[k]


def coast(T, x, y, r=3):
    w, h, raw = T
    for yy in range(max(0, y - r), min(h, y + r + 1)):
        for xx in range(max(0, x - r), min(w, x + r + 1)):
            if raw[yy * w + xx] & 0x20:
                return True
    return False


def main():
    rows = list(csv.DictReader(open(INDEX, encoding="utf-8")))
    out = []
    missing = collections.Counter()
    for r in rows:
        if r["src"] not in ("full", "world", "slim"):
            continue
        d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
        if r["src"] == "slim":
            spawns = [(float(s[0]), int(s[1]), s[2]) for s in d.get("spawns", [])]
            winner_cid = d["winner"][1] if d.get("winner") and len(d["winner"]) > 1 else None
            mapname, size = d["map"], d["size"]
        else:
            winner_cid = (d["info"].get("winner") or [None, None])[1]
            mapname, size = d["info"]["config"]["gameMap"], d["info"]["config"]["gameMapSize"]
            spawns = []
            for t in d["turns"]:
                for it in t["intents"]:
                    if it.get("type") == "spawn":
                        spawns.append((t["turnNumber"] / 10, int(it["tile"]), it["clientID"]))
            last = {}  # players re-pick 3-7 times in the spawn phase: keep each player's final pick
            for t_, tile_, cid_ in spawns:
                last[cid_] = (t_, tile_, cid_)
            spawns = list(last.values())
        T = terrain(mapname, size)
        if T is None:
            missing[(mapname, size)] += 1
            continue
        w = T[0]
        for t, tile, cid in spawns:
            x, y = tile % w, tile // w
            out.append(dict(gid=r["gid"], src=r["src"], map=mapname, size=size, t_s=t, tile=tile, x=x, y=y,
                            coast="yes" if coast(T, x, y) else "no", winner=int(cid == winner_cid)))
    with open(OUT, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(out[0].keys()))
        writer.writeheader(); writer.writerows(out)
    C = collections.Counter
    print("spawn rows", len(out), "games", len({o["gid"] for o in out}))
    print("missing terrain (games skipped)", dict(missing))
    print("maps", C(o["map"] for o in out).most_common(10))
    print("coast yes share %", round(100 * C(o["coast"] for o in out)["yes"] / max(1, len(out)), 1))


if __name__ == "__main__":
    main()
