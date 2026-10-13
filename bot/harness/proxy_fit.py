# Fit P(win | state at minute M) on cached full games (pure python logistic regression).
# Usage: python proxy_fit.py games_cache.jsonl [M=20]  -> prints coefficients + CV AUC.
import json, math, sys, random
M = sys.argv[2] if len(sys.argv) > 2 else "20"
rows = []
for l in open(sys.argv[1]):
    d = json.loads(l); r = d["r"]
    if d["k"].split("|")[4] != "75": continue  # full games only
    if r.get("minutes", 0) < 30 and r["outcome"] not in ("win", "lost", "dead"): continue
    if r["outcome"] == "dead" and (r.get("deathMin") or 0) >= float(M): pass
    full = r["outcome"] in ("win", "lost") or r.get("minutes", 0) >= 30 or r["outcome"] == "dead"
    if not full or r.get("outcome") == "snap": continue
    cp = (r.get("checkpoints") or {}).get(M + "m")
    y = 1 if r["outcome"] == "win" else 0
    players = (r.get("lobby") or {}).get("players", 50)
    rows.append((cp, y, players, r))
# keep only games that ran to the end (75 min cap) -- key contains |75|
def feats(cp, players):
    s = max(cp["share"], 1e-4); L = max(cp.get("L", s), 1e-4)
    return [1.0, math.log(s), math.log(s / L), math.log(players / 50)]
data = [(feats(cp, p), y) for cp, y, p, r in rows if cp]
dead = sum(1 for cp, y, p, r in rows if not cp)
deadw = sum(y for cp, y, p, r in rows if not cp)
print(f"games {len(rows)} alive@{M}m {len(data)} wins_alive {sum(y for _,y in data)} dead_before {dead} (wins {deadw})")
def fit(D, l2=0.01, it=3000, lr=0.1):
    w = [0.0] * len(D[0][0])
    for _ in range(it):
        g = [0.0] * len(w)
        for x, y in D:
            p = 1 / (1 + math.exp(-sum(a * b for a, b in zip(w, x))))
            for i in range(len(w)): g[i] += (p - y) * x[i]
        for i in range(len(w)): w[i] -= lr * (g[i] / len(D) + l2 * w[i] * (i > 0))
    return w
def pred(w, x): return 1 / (1 + math.exp(-sum(a * b for a, b in zip(w, x))))
def auc(ps):
    pos = [p for p, y in ps if y]; neg = [p for p, y in ps if not y]
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / max(1, len(pos) * len(neg))
random.seed(1); idx = list(range(len(data))); random.shuffle(idx)
out = []
for k in range(5):
    te = set(idx[k::5]); w = fit([data[i] for i in idx if i not in te])
    out += [(pred(w, data[i][0]), data[i][1]) for i in te]
w = fit(data)
print("cv AUC among alive", round(auc(out), 3))
# all games incl. dead-before-M (p=0)
allps = out + [(0.0, y) for cp, y, p, r in rows if not cp]
print("cv AUC all games", round(auc(allps), 3))
print("w =", [round(v, 4) for v in w], "(bias, log share, log share/leader, log players/50)")
