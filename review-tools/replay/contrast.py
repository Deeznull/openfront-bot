"""Winner vs other-player contrast in default 30+ FFA, plus tactic_weights cross-check metrics.
Usage: python -I contrast.py world|both   (world = tools/replays_world; both = tools/replays + replays_world)
Per player (median over players with any intent): first City/Port/Factory/SAM Launcher/Missile Silo build (s),
alliance requests by 5:00, first nuke launch (Atom/H/MIRV, s), nuke launches, first Defense Post (s),
third-party share (attacks on a target that another player attacked in the prior 60 s),
break-then-hit (alliance break followed by an attack on that player within 30 s), donate_gold and embargo counts."""
import csv, json, os, sys, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
SRCS = ("world",) if sys.argv[1:] == ["world"] else ("world", "full")
NUKES = ("Atom Bomb", "Hydrogen Bomb", "MIRV")
BUILDS = {"City": "city", "Port": "port", "Factory": "fact", "SAM Launcher": "sam", "Missile Silo": "silo", "Defense Post": "dp"}
rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if r["src"] in SRCS and int(r["turns"] or 0) > 0]

M = collections.defaultdict(lambda: collections.defaultdict(list))
games = 0
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    win = (d["info"].get("winner") or [None, None])[1]
    if win is None:
        continue
    games += 1
    first = collections.defaultdict(dict)       # cid -> {key: t}
    cnt = collections.defaultdict(collections.Counter)
    req5 = collections.Counter()
    nukes = collections.defaultdict(list)
    attacks = []                                 # (t, cid, target)
    breaks = []
    touched = set()
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            cid, ty = it.get("clientID"), it.get("type")
            if ty == "build_unit":
                u = it.get("unit")
                if u in NUKES:
                    nukes[cid].append(t); cnt[cid]["nuke"] += 1
                    if u == "MIRV":
                        cnt[cid]["mirv"] += 1
                    first[cid].setdefault("nuke", t)
                elif u in BUILDS:
                    first[cid].setdefault(BUILDS[u], t)
            elif ty == "allianceRequest":
                if t <= 300:
                    req5[cid] += 1
            elif ty == "attack":
                attacks.append((t, cid, it.get("targetID")))
            elif ty == "breakAlliance":
                breaks.append((t, cid, it.get("recipient")))
            elif ty == "donate_gold":
                cnt[cid]["gold"] += 1
            elif ty == "embargo":
                cnt[cid]["embargo"] += 1
            elif ty == "boat":
                first[cid].setdefault("boat", t)
    attacks.sort(key=lambda a: a[0])
    # third-party: attack on target T where another player attacked T in the prior 60 s
    last_hit = {}                                # target -> [(t, attacker)]
    tp = collections.Counter(); tot = collections.Counter()
    for t, cid, tgt in attacks:
        if tgt is None:
            continue
        recent = [a for ta, a in last_hit.get(tgt, []) if t - ta <= 60 and a != cid]
        tot[cid] += 1
        if recent:
            tp[cid] += 1
        last_hit.setdefault(tgt, []).append((t, cid))
    atk_by = collections.defaultdict(list)
    for t, cid, tgt in attacks:
        atk_by[cid].append((t, tgt))
    for t, cid, rec in breaks:
        if rec is not None and any(tg == rec and t <= at <= t + 30 for at, tg in atk_by.get(cid, [])):
            cnt[cid]["bhit"] += 1
        cnt[cid]["brk"] += 1
    players = set(first) | set(cnt) | set(req5) | set(tot)
    for p in players:
        g = "W" if p == win else "O"
        m = M[g]
        for k in ("city", "port", "fact", "sam", "silo", "dp", "nuke", "boat"):
            m[k].append(first[p].get(k))
        m["req_5min"].append(req5[p])
        m["nuke_n"].append(cnt[p]["nuke"])
        m["third_party"].append(tp[p] / tot[p] if tot[p] else None)
        m["break_hit"].append(cnt[p]["bhit"] / cnt[p]["brk"] if cnt[p]["brk"] else None)
        m["gold_donations"].append(cnt[p]["gold"])
        m["embargoes"].append(cnt[p]["embargo"])
        m["mirv_any"].append(int(cnt[p]["mirv"] > 0))
        m["sum_bhit"].append(cnt[p]["bhit"]); m["sum_brk"].append(cnt[p]["brk"])
        m["sum_tp"].append(tp[p]); m["sum_tot"].append(tot[p])
        m["sum_gold"].append(cnt[p]["gold"]); m["sum_emb"].append(cnt[p]["embargo"])
        m["dp_any"].append(int(first[p].get("dp") is not None))

def med(xs):
    xs = [x for x in xs if x is not None]
    return "%.0f n=%d" % (st.median(xs), len(xs)) if xs else "n=0"

def medf(xs):
    xs = [x for x in xs if x is not None]
    return "%.2f n=%d" % (st.median(xs), len(xs)) if xs else "n=0"

def share(xs):
    xs = [x for x in xs if x is not None]
    return "%.0f%% n=%d" % (100 * sum(1 for x in xs if x) / len(xs), len(xs)) if xs else "n=0"

print("sources", SRCS, "games", games)
for g, lab in (("W", "winners"), ("O", "others")):
    m = M[g]
    print(lab + ": first City %s | Port %s | Factory %s | SAM %s | Silo %s | Defense Post %s | first boat %s"
          % tuple(med(m[k]) for k in ("city", "port", "fact", "sam", "silo", "dp", "boat")))
    print("  alliance requests by 5:00 %s | first nuke %s | nuke launches %s | share of players with nuke %s"
          % (med(m["req_5min"]), med(m["nuke"]), med(m["nuke_n"]), share([x > 0 for x in m["nuke_n"]])))
    print("  third-party share of attacks %s | break-then-hit %s | gold donations %s | embargoes %s"
          % (medf(m["third_party"]), medf(m["break_hit"]), med(m["gold_donations"]), med(m["embargoes"])))

for g, lab in (("W", "winners"), ("O", "others")):
    m = M[g]
    pooled = lambda k: sum(m[k])
    print("pooled %s: players %d | MIRV launched by %s | defense post built by %s | break->hit %d/%d | third-party %d/%d attacks | gold donations %d | embargoes %d"
          % (lab, len(m["mirv_any"]), share(m["mirv_any"]), share(m["dp_any"]), pooled("sum_bhit"), pooled("sum_brk"),
             pooled("sum_tp"), pooled("sum_tot"), pooled("sum_gold"), pooled("sum_emb")))
