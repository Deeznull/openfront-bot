"""Outcome-only study of default FFA 30+ slim replays (tools/replays_slim, rows from out/ffa30_index.csv, src=slim).
Slim files have no turns, so only header-level stats: winner tile share, peak troops, spawn timing, player counts.
Run: python -I tools/replay_tools/ffa30_slim.py"""
import csv, json, os, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)


def q(xs):
    xs = sorted(xs)
    if not xs:
        return "n=0"
    qs = st.quantiles(xs, n=4) if len(xs) >= 4 else [xs[0], xs[0], xs[-1]]
    return "%.1f [%.1f-%.1f] n=%d" % (st.median(xs), qs[0], qs[2], len(xs))


rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8")) if r["src"] == "slim"]
share, peak_ratio, win_spawn, all_spawn, dur, nplayers, alive = [], [], [], [], [], [], []
by_map = collections.defaultdict(list)
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    P = d["players"]
    wid = d["winner"][1] if d.get("winner") and len(d["winner"]) > 1 else None
    tot = sum(int(p.get("finalTiles") or 0) for p in P) or 1
    w = [p for p in P if p["cid"] == wid]
    if not w:
        continue
    w = w[0]
    share.append(100.0 * int(w.get("finalTiles") or 0) / tot)
    peaks = [int(p.get("peak") or 0) for p in P]
    if max(peaks):
        peak_ratio.append(100.0 * int(w.get("peak") or 0) / max(peaks))
    spawn_t = {sp[2]: sp[0] for sp in d.get("spawns", [])}
    if wid in spawn_t:
        win_spawn.append(spawn_t[wid])
    all_spawn += list(spawn_t.values())
    dur.append(d["duration"] / 60)
    nplayers.append(len(P))
    alive.append(sum(1 for p in P if p.get("killedAt") is None))
    by_map[d["map"]].append(100.0 * int(w.get("finalTiles") or 0) / tot)
print("slim games", len(rows))
print("winner tile share % of all final tiles", q(share))
print("winner peak as % of max peak", q(peak_ratio))
print("winner spawn second", q(win_spawn), "| all spawns second", q(all_spawn))
print("duration min", q(dur), "| players", q(nplayers), "| alive at end", q(alive))
print("winner share by map (median, n):")
for m, v in sorted(by_map.items(), key=lambda x: -len(x[1]))[:6]:
    print("  %s: %.1f%% n=%d" % (m, st.median(v), len(v)))
