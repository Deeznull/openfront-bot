"""Download map terrain bins (public OpenFrontIO repo) for the maps used in cached replays; stored zlib-compressed in tools/maps.
Run: python -I fetchmaps.py   (<=1 request/s; stops on any HTTP error)"""
import json, glob, re, os, sys, time, zlib, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
key = lambda n: re.sub(r"[^a-z0-9]", "", n.lower())
need = set()
for f in glob.glob(os.path.join(HERE, "replays", "c*.json")):
    d = json.load(open(f, encoding="utf-8")); c = d["info"]["config"]
    need.add((key(c["gameMap"]), "map4x" if c["gameMapSize"] == "Compact" else "map"))
for f in glob.glob(os.path.join(HERE, "replays_slim", "c*.json")):
    d = json.load(open(f, encoding="utf-8"))
    need.add((key(d["map"]), "map4x" if d["size"] == "Compact" else "map"))
last = 0
for k, v in sorted(need):
    out = os.path.join(HERE, "maps", f"{k}_{v}.z")
    if os.path.exists(out): continue
    mp = os.path.join(HERE, "maps", f"{k}_manifest.json")
    if not os.path.exists(mp):
        time.sleep(max(0, 1.1 - (time.time() - last))); last = time.time()
        open(mp, "wb").write(urllib.request.urlopen(urllib.request.Request(f"https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/{k}/manifest.json", headers={"User-Agent": "training-analysis"}), timeout=60).read())
    time.sleep(max(0, 1.1 - (time.time() - last))); last = time.time()
    url = f"https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/{k}/{v}.bin"
    try:
        raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "training-analysis"}), timeout=120).read()
    except urllib.error.HTTPError as e:
        print("HTTP error", e.code, url); sys.exit(1)
    open(out, "wb").write(zlib.compress(raw, 9)); print(k, v, len(raw), flush=True)
