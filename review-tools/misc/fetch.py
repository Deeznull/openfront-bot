"""Fetch recent OpenFront FFA replays (<=1 req/s, cached, stop on any HTTP error).
Run: python -I fetch.py [N]   (from a short path, e.g. a subst drive: Windows MAX_PATH)"""
import json, os, sys, time, urllib.request, urllib.error, datetime
SP = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(SP, "replays")
os.makedirs(CACHE, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (personal training analysis; 1 req/s)"}
last = [0.0]
def get(url):
    w = 1.1 - (time.time() - last[0])
    if w > 0: time.sleep(w)
    last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        print("HTTP error", e.code, url, e.read()[:200]); sys.exit(1)
def main(n):
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    f = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
    games = []
    for k in range(3):                      # three 24h windows -> last 3 days
        e = now - datetime.timedelta(days=k); s = e - datetime.timedelta(days=1)
        lp = os.path.join(CACHE, f"list_{k}.json")
        if not os.path.exists(lp):
            open(lp, "wb").write(get(f"https://api.openfront.io/public/games?start={f(s)}&end={f(e)}&type=Public&mode=Free%20For%20All&limit=500"))
        games += json.load(open(lp, encoding="utf-8"))
    print("listed", len(games))
    # unranked multi-player FFA only, with real length
    ok = [g for g in games if g.get("rankedType") in (None, "unranked") and g["numPlayers"] >= 10]
    print("unranked >=10 players:", len(ok))
    ok.sort(key=lambda g: g["start"])
    step = max(1, len(ok) // n)
    pick = ok[::step][:n]
    json.dump(pick, open(os.path.join(SP, "picked.json"), "w"))
    for i, g in enumerate(pick):
        p = os.path.join(CACHE, g["game"] + ".json")
        if os.path.exists(p): continue
        raw = get("https://api.openfront.io/public/game/" + g["game"])
        open(p, "wb").write(raw)
        print(i, g["game"], g["start"], g["numPlayers"], len(raw), flush=True)
main(int(sys.argv[1]) if len(sys.argv) > 1 else 50)
