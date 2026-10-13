"""Part B and C of the orchestrator loop, default 30+ FFA.
B (World maps = replays_world non-Giant, 33 games): winner's first 3 attacks (time, target class, troops) and first alliance request.
C (all 146 full-turn games): games where the winner was attacked before 5:00 by a player with higher peak troops
    (peak = stats.peakTroops, whole game; proxy for 'bigger neighbour'). Response measured in the 120 s after that first attack.
Target classes come from tools/load.py: human / nation / bot (non-replay id) / wild (no target).
Writes out/openings_world.csv and out/survival.csv. Run: python -I openings_survival.py"""
import csv, json, os, sys, statistics as st, collections
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(TOOLS))
from load import parse
from spawn_tiles import terrain  # noqa: F401

idx = list(csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8")))
full = [r for r in idx if r["src"] in ("world", "full") and int(r["turns"] or 0) > 0]
EARLY = 300
BIG = 0.5  # attacker end-game peak troops at least this share of the winner peak (proxy for bigger)

B, C = [], []
for r in full:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    g = parse(d)
    if g is None:
        continue
    W = g["winner"]
    cmap = g["map"]
    if r["src"] == "world" and "Giant" not in cmap:
        atk = sorted(W["attacks"])[:3]
        first_req = min(W["req"])[0] if W["req"] else None
        first_req_cls = min(W["req"])[2] if W["req"] else None
        B.append(dict(gid=g["gid"], map=cmap,
                      a1=("%s %s %.0f" % (atk[0][2], atk[0][1], atk[0][0])) if len(atk) > 0 else "",
                      a2=("%s %s %.0f" % (atk[1][2], atk[1][1], atk[1][0])) if len(atk) > 1 else "",
                      a3=("%s %s %.0f" % (atk[2][2], atk[2][1], atk[2][0])) if len(atk) > 2 else "",
                      first_alliance_req=("%.0f %s" % (first_req, first_req_cls)) if first_req is not None else ""))
    # C: attacks on the winner before 5:00 by a player with higher peak troops
    byid = {p["pid"]: p for p in g["players"]}
    hits = []
    for p in g["players"]:
        if p is W:
            continue
        for t, troops, cls, tid in p["attacks"]:
            if tid == W["pid"] and t < EARLY and p["peak"] >= BIG * W["peak"]:
                hits.append((t, p))
    if not hits or W["peak"] <= 0:
        continue
    t0, X = min(hits, key=lambda h: h[0])
    win_resp = [a for a in W["attacks"] if t0 <= a[0] <= t0 + 120]
    req_X = [q for q in W["req"] if q[1] == X["pid"] and t0 <= q[0] <= t0 + 120]
    dp5 = sum(1 for t, u in W["builds"] if u == "Defense Post" and t <= EARLY)
    C.append(dict(gid=g["gid"], src=r["src"], map=cmap, winner_peak=W["peak"], attacker_peak=X["peak"],
                  first_bigger_attack_s=round(t0), attacker_killed_s=("" if X["killed"] is None else round(X["killed"])),
                  n_bigger_attacks_before_5m=sum(1 for p in g["players"] if p is not W for a in p["attacks"] if a[3] == W["pid"] and a[0] < EARLY and p["peak"] >= BIG * W["peak"]),
                  winner_attacks_120s=len(win_resp), winner_req_to_attacker_120s=len(req_X),
                  winner_defense_posts_5m=dp5, winner_final_rank=W["rank"]))

os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
with open(os.path.join(HERE, "out", "openings_world.csv"), "w", newline="", encoding="utf-8") as f:
    wr = csv.DictWriter(f, fieldnames=list(B[0].keys())); wr.writeheader(); wr.writerows(B)
with open(os.path.join(HERE, "out", "survival.csv"), "w", newline="", encoding="utf-8") as f:
    wr = csv.DictWriter(f, fieldnames=list(C[0].keys())); wr.writeheader(); wr.writerows(C)
print("B world non-Giant games:", len(B))
print("C games with a bigger attacker before 5:00:", len(C), "of", sum(1 for r in full))
if C:
    def med(k): 
        xs = [c[k] for c in C if c[k] not in ("", None)]
        return "%.1f n=%d" % (st.median(xs), len(xs)) if xs else "n=0"
    print("  winner attacks in 120 s %s | requests to attacker in 120 s %s | defense posts by 5:00 %s" % (med("winner_attacks_120s"), med("winner_req_to_attacker_120s"), med("winner_defense_posts_5m")))
    print("  attacker killed later? %s" % collections.Counter(("killed" if c["attacker_killed_s"] != "" else "alive") for c in C))
    print("  winner final rank 1 share %s" % ("%.0f%%" % (100.0 * sum(1 for c in C if c["winner_final_rank"] == 1) / len(C))))
