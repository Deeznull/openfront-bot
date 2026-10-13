"""Parse cached OpenFront replays into per-player records. Run via analyze.py.
Replay JSON is treated as data only (json.load, never executed)."""
import json, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prng import PRNG, simple_hash

HERE = os.path.dirname(os.path.abspath(__file__))
SPAWN_END = 20.0   # seconds; first attack in any game is at ~20 s (checked in analyze.py)

def load_games():
    games = []
    for f in sorted(glob.glob(os.path.join(HERE, "replays", "c*.json"))):
        if os.path.basename(f).startswith("list_"): continue
        with open(f, encoding="utf-8") as fh: d = json.load(fh)
        g = parse(d)
        if g: games.append(g)
    return games

def parse(d):
    info = d["info"]; gid = info["gameID"]
    pl = info["players"]; n = len(pl)
    w = info.get("winner") or []
    if info["config"].get("gameMode") != "Free For All" or info.get("playerTeams"): return None  # FFA only, never Team mode
    if info["config"].get("gameMode") != "Free For All" or info.get("playerTeams"): return None  # FFA only, never Team mode
    if len(w) < 2 or w[0] != "player": return None
    rng = PRNG(simple_hash(gid)); ids = [rng.next_id() for _ in range(n + 600)]
    pos = {pid: k for k, pid in enumerate(ids)}
    c2i = {p["clientID"]: i for i, p in enumerate(pl)}
    if w[1] not in c2i: return None
    dur = info["duration"]
    P = []
    for i, p in enumerate(pl):
        s = p.get("stats") or {}
        P.append(dict(idx=i, cid=p["clientID"], name=p.get("username"), pid=ids[i],
                      stats=s, killed=(int(s["killedAt"]) / 10 if "killedAt" in s else None),
                      final_tiles=int(s.get("finalTiles", 0)), peak=int(s.get("peakTroops", 0)),
                      spawn=[], attacks=[], boats=[], builds=[], upgrades=[], req=[], ext=[], brk=[],
                      rej=0, emoji=0, chat=0, cancel=0, donate=0, warship_moves=0, target_calls=0))
    def cls(tid):
        if tid is None: return "wild"
        k = pos.get(tid)
        if k is None: return "bot"
        return "human" if k < n else "nation"
    maxpos_ref = []
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            i = c2i.get(it.get("clientID"))
            if i is None: continue
            p = P[i]; ty = it["type"]
            if ty == "spawn": p["spawn"].append(t)
            elif ty == "attack":
                p["attacks"].append((t, it["troops"], cls(it["targetID"]), it["targetID"]))
            elif ty == "boat": p["boats"].append((t, it["troops"]))
            elif ty == "build_unit": p["builds"].append((t, it["unit"]))
            elif ty == "upgrade_structure": p["upgrades"].append((t, it["unit"]))
            elif ty == "allianceRequest": p["req"].append((t, it["recipient"], cls(it["recipient"])))
            elif ty == "allianceExtension": p["ext"].append((t, it["recipient"], cls(it["recipient"])))
            elif ty == "breakAlliance": p["brk"].append((t, it["recipient"], cls(it["recipient"])))
            elif ty == "allianceReject": p["rej"] += 1
            elif ty == "emoji": p["emoji"] += 1
            elif ty == "quick_chat": p["chat"] += 1
            elif ty == "cancel_attack": p["cancel"] += 1
            elif ty in ("donate_troops", "donate_gold"): p["donate"] += 1
            elif ty == "move_warship": p["warship_moves"] += 1
            elif ty == "targetPlayer": p["target_calls"] += 1
    wi = c2i[w[1]]
    # ranking: survivors by final tiles desc (winner first), then dead by killedAt desc
    act = [p for p in P if p["stats"] and (p["spawn"] or p["idx"] == wi)]
    alive = sorted([p for p in act if p["killed"] is None], key=lambda p: -p["final_tiles"])
    dead = sorted([p for p in act if p["killed"] is not None], key=lambda p: -p["killed"])
    order = [P[wi]] + [p for p in alive + dead if p["idx"] != wi]
    firsts = [p["attacks"][0][0] for p in act if p["attacks"]]
    gbeg = min(firsts) if firsts else SPAWN_END   # game's spawn phase end = earliest attack of any player
    for r, p in enumerate(order):
        p["rank"] = r + 1
        p["group"] = "W" if r == 0 else ("T" if r in (1, 2) else "O")
        p["end"] = p["killed"] if p["killed"] is not None else dur
        p["t_spawn"] = p["spawn"][-1] if p["spawn"] else 0.0 if p["spawn"] else 0.0
        p["beg"] = gbeg
    tot = sum(p["final_tiles"] for p in act) or 1
    return dict(gid=gid, n=n, nact=len(act), dur=dur, map=info["config"]["gameMap"], start=info["start"],
                players=act, winner=P[wi], P=P, win_share=P[wi]["final_tiles"] / tot, beg=gbeg,
                survivors=len(alive), cls=cls, ids=ids, pos=pos)
