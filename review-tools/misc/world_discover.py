"""Discover public FFA World-map games of the last 7 days via the public per-player history endpoint
(GET /public/player/<publicId>/games?filter=ffa&type=public, 10 results/page, includes `map`).
The game list endpoint has no map field, so this is the only way to find World games without downloading replays.
<=1 request/s, state cached on disk (replays_world/hist_state.json), stops at the first HTTP error or 429.
Run: python -I world_discover.py <max_requests> <max_pages_per_player> [seed_pids.json]"""
import json, os, sys, time, random, datetime, glob, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "replays_world"); os.makedirs(OUT, exist_ok=True)
STATE = os.path.join(OUT, "hist_state.json")
UA = {"User-Agent": "Mozilla/5.0 (personal training analysis; 1 req/s)"}
last = [0.0]
def get(url):
    w = 1.1 - (time.time() - last[0])
    if w > 0: time.sleep(w)
    last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return r.read()
    except urllib.error.HTTPError as e:
        print("HTTP error", e.code, url, flush=True); save(); sys.exit(1)
def save():
    json.dump(S, open(STATE + ".tmp", "w")); os.replace(STATE + ".tmp", STATE)
S = json.load(open(STATE)) if os.path.exists(STATE) else {"players": {}, "games": {}, "reqs": 0}
def seed_from_replays():
    for f in glob.glob(os.path.join(HERE, "replays", "c*.json")) + glob.glob(os.path.join(OUT, "c*.json")):
        d = json.load(open(f, encoding="utf-8"))
        for p in d["info"]["players"]:
            pid = p.get("publicID")
            if pid and pid not in S["players"]: S["players"][pid] = {"cur": None, "pages": 0, "done": False}
def main(maxreq, maxpages):
    seed_from_replays()
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
    rnd = random.Random(7)
    todo = sorted(S["players"]); rnd.shuffle(todo)
    # players that already have World games first (heavier World players), then the rest
    n = 0
    for pid in todo:
        st = S["players"][pid]
        while not st["done"] and st["pages"] < maxpages:
            if n >= maxreq: save(); print("budget reached", n, "games", len(S["games"]), flush=True); return
            url = f"https://api.openfront.io/public/player/{pid}/games?filter=ffa&type=public" + (f"&cursor={st['cur']}" if st["cur"] else "")
            j = json.loads(get(url)); n += 1; S["reqs"] += 1
            st["pages"] += 1; st["cur"] = j.get("nextCursor")
            old = False
            for g in j["results"]:
                if g["start"] < cutoff: old = True; continue
                S["games"][g["gameId"]] = {k: g[k] for k in ("start", "durationSeconds", "map", "mode", "type", "playerTeams", "rankedType", "totalPlayers")}
            if old or not st["cur"] or not j["results"]: st["done"] = True
            if n % 50 == 0:
                save(); w = sum(1 for g in S["games"].values() if g["map"] == "World")
                print(f"req {n} games {len(S['games'])} world {w}", flush=True)
    save(); print("done", n, len(S["games"]), flush=True)
main(int(sys.argv[1]), int(sys.argv[2]))
