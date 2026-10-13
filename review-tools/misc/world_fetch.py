"""Download World-map public FFA replays chosen from replays_world/hist_state.json (made by world_discover.py).
Selection: games with map == "World", 10+ players, last 7 days, spread evenly over time (equal quota per UTC day,
then evenly spaced inside the day; unused quota moves to days with more candidates).
<=1 request/s, hard cap 150 downloads per run (counts cached files too), stops at the first HTTP error / 429.
Run: python -I world_fetch.py [target=120]   (data goes to tools\replays_world, treated as data, never executed)"""
import json, os, sys, time, urllib.request, urllib.error, collections
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "replays_world")
UA = {"User-Agent": "Mozilla/5.0 (personal training analysis; 1 req/s)"}
CAP = 150
last = [0.0]
def get(url):
    w = 1.1 - (time.time() - last[0])
    if w > 0: time.sleep(w)
    last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r: return r.read()
    except urllib.error.HTTPError as e:
        print("HTTP error", e.code, url, flush=True); sys.exit(1)
def select(cands, target):
    byday = collections.defaultdict(list)
    for g in sorted(cands, key=lambda g: g["start"]): byday[g["start"][:10]].append(g)
    days = sorted(byday); quota = {d: 0 for d in days}
    left = target
    while left > 0 and any(quota[d] < len(byday[d]) for d in days):      # round-robin: equal quota per day
        for d in days:
            if left > 0 and quota[d] < len(byday[d]): quota[d] += 1; left -= 1
    pick = []
    for d in days:
        L = byday[d]; q = quota[d]
        if q == 0: continue
        pick += [L[int((i + .5) * len(L) / q)] for i in range(q)] if q < len(L) else L
    return pick, {d: (len(byday[d]), quota[d]) for d in days}
def main(target):
    """Order: (1) every game in top_player_games.json (top-10 trackerfront players), (2) general public FFA games on
    World / Giant World Map / World Inverted from the last 7 days with start >= 2026-10-06 (v0.34.24 window), 10+ players,
    quota per map below, equal quota per UTC day. Total downloads capped at CAP (150) incl. cached files."""
    S = json.load(open(os.path.join(OUT, "hist_state.json")))
    top = json.load(open(os.path.join(HERE, "top_player_games.json")))["games"]
    topids = [g["game_id"] for g in top if g["mode"] == "Free For All"]
    QUOTA = {"Giant World Map": 45, "World": 30, "World Inverted": 20}
    pick = []
    for m, qn in QUOTA.items():
        cands = [dict(S["games"][k], gid=k) for k in S["games"] if S["games"][k]["map"] == m and (S["games"][k]["totalPlayers"] or 0) >= 10
                 and S["games"][k]["mode"] == "Free For All" and S["games"][k]["type"] == "Public" and not S["games"][k]["playerTeams"]
                 and S["games"][k]["start"] >= "2026-10-06" and k not in topids]
        p, info = select(cands, qn)
        print(m, "candidates", len(cands), "picked", len(p), "per day (cands, quota):", info, flush=True)
        pick += p
    order = [(gid, "top") for gid in topids] + [(g["gid"], "general") for g in pick]
    assert len(order) <= CAP, len(order)
    json.dump(order, open(os.path.join(OUT, "picked_world.json"), "w"))
    n = 0
    for gid, kind in order:
        p = os.path.join(OUT, gid + ".json")
        if os.path.exists(p): continue
        if n >= CAP: break
        raw = get("https://api.openfront.io/public/game/" + gid); n += 1
        open(p, "wb").write(raw)
        print(n, gid, kind, len(raw), flush=True)
    print("downloaded", n, flush=True)
main(0)
