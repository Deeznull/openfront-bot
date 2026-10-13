"""Fetch extra FFA replays and keep only what the spawn analysis needs (slim JSON in tools/replays_slim).
<=1 request/s, stops on any HTTP error.  Run: python -I fetch_spawns.py [N]"""
import json, os, sys, time, glob, datetime, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "replays_slim"); os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join(HERE, "replays")
UA = {"User-Agent": "Mozilla/5.0 (personal training analysis; 1 req/s)"}
last = [0.0]
def get(url):
    w = 1.1 - (time.time() - last[0])
    if w > 0: time.sleep(w)
    last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r: return r.read()
    except urllib.error.HTTPError as e:
        print("HTTP error", e.code, url); sys.exit(1)
def slim(d):
    i = d["info"]; c = i["config"]
    sp = [[t["turnNumber"], it["tile"], it["clientID"]] for t in d["turns"] for it in t["intents"] if it["type"] == "spawn"]
    pl = [{"cid": p["clientID"], "name": p.get("username"), "finalTiles": int((p.get("stats") or {}).get("finalTiles", 0)),
           "killedAt": (p.get("stats") or {}).get("killedAt"), "hasStats": bool(p.get("stats")), "peak": (p.get("stats") or {}).get("peakTroops")} for p in i["players"]]
    return {"gameID": i["gameID"], "start": i["start"], "duration": i["duration"], "map": c["gameMap"], "size": c["gameMapSize"],
            "mode": c["gameMode"], "cfg": {k: c.get(k) for k in ("nations", "randomSpawn", "maxPlayers", "bots", "gameMapSize")}, "teams": i.get("playerTeams"), "winner": i.get("winner"), "players": pl, "spawns": sp}
def main(n):
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    f = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
    games = {}
    for k in range(12):                      # twelve 6 h windows = last 3 days, whole day covered
        e = now - datetime.timedelta(hours=6 * k); s = e - datetime.timedelta(hours=6)
        lp = os.path.join(OUT, f"list6h_{k}.json")
        if not os.path.exists(lp):
            open(lp, "wb").write(get(f"https://api.openfront.io/public/games?start={f(s)}&end={f(e)}&type=Public&mode=Free%20For%20All&limit=500"))
        for g in json.load(open(lp, encoding="utf-8")): games[g["game"]] = g
    ok = [g for g in games.values() if g.get("rankedType") in (None, "unranked") and g["numPlayers"] >= 10]
    print("listed", len(games), "unranked>=10:", len(ok))
    ok.sort(key=lambda g: g["start"])
    step = max(1, len(ok) // n)
    for i, g in enumerate(ok[::step][:n]):
        out = os.path.join(OUT, g["game"] + ".json")
        if os.path.exists(out) and "cfg" in json.load(open(out)): continue   # re-fetch older slim files that lack cfg
        full = os.path.join(CACHE, g["game"] + ".json")
        d = json.load(open(full, encoding="utf-8")) if os.path.exists(full) else json.loads(get("https://api.openfront.io/public/game/" + g["game"]))
        json.dump(slim(d), open(out, "w")); print(i, g["game"], flush=True)
main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
