"""Scenario rows: situation -> what GOOD (top 10%) and BAD (bottom half) players did next.
Situations (triggers, from intents only, 146 default 30+ FFA games):
  attacked_by_human   : a human attacked you (you = X); window 10 s for counter, 30 s for builds/boats
  betrayed_by_ally    : an ally broke the alliance with you; window 30 s
  alliance_req_received: a human sent you an alliance request; window 30 s
Responses (after the trigger, in its window):
  counter_attacker    : you attacked that attacker (10 s for attacked, 30 s for betrayed)
  counter_any         : you attacked anyone (10 s)
  defence_build       : you built a Defense Post, SAM Launcher or Warship (30 s)
  boat                : you launched a boat (30 s)
  request_back        : you sent an alliance request to that human (30 s)
GOOD = rank <= ceil(0.10 N), BAD = rank > ceil(N/2). Time buckets: 0-2:00, 2:00-5:00, 5:00+.
Triggers are not independent (one player can be hit many times). Intents only: no outcomes.
Writes out/scenarios.csv. Run: python -I scenarios.py"""
import csv, json, math, os, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)
from load import parse  # noqa: E402

rows = [r for r in csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8"))
        if int(r["turns"] or 0) > 0]
DEF_UNITS = {"Defense Post", "SAM Launcher", "Warship"}
BUCKETS = [(0, 120, "0-2:00"), (120, 300, "2:00-5:00"), (300, 1e9, "5:00+")]

# counts[(scenario, group, bucket)] -> dict(n, response -> hits)
counts = collections.defaultdict(lambda: collections.Counter())
triggers_n = collections.Counter()


def bucket(t):
    for lo, hi, name in BUCKETS:
        if lo <= t < hi:
            return name
    return None


games = 0
for r in rows:
    d = json.load(open(os.path.join(TOOLS, r["path"]), encoding="utf-8"))
    g = parse(d)
    if g is None:
        continue
    games += 1
    N = len(g["players"])
    good_max = math.ceil(0.10 * N)
    bad_min = math.ceil(N / 2) + 1
    pid2p = {p["pid"]: p for p in g["players"]}
    cid2p = {p["cid"]: p for p in g["players"]}
    grp_of = {}
    for p in g["players"]:
        grp_of[p["cid"]] = "GOOD" if p["rank"] <= good_max else ("BAD" if p["rank"] >= bad_min else None)

    # per-actor event lists (t, kind, target_pid_or_unit)
    ev = collections.defaultdict(list)
    triggers = []  # (t, victim_cid, scenario, window, attacker_pid or None)
    for turn in d["turns"]:
        t = turn["turnNumber"] / 10
        for it in turn["intents"]:
            a = cid2p.get(it.get("clientID"))
            if a is None:
                continue
            ty = it.get("type")
            if ty == "attack":
                tgt = it.get("targetID")
                ev[a["cid"]].append((t, "attack", tgt))
                x = pid2p.get(tgt)
                if x is not None:
                    triggers.append((t, x["cid"], "attacked_by_human", 10, a["pid"]))
            elif ty == "build_unit":
                ev[a["cid"]].append((t, "build", it.get("unit")))
            elif ty == "boat":
                ev[a["cid"]].append((t, "boat", None))
            elif ty == "allianceRequest":
                rec = it.get("recipient")
                ev[a["cid"]].append((t, "req", rec))
                x = pid2p.get(rec)
                if x is not None:
                    triggers.append((t, x["cid"], "alliance_req_received", 30, a["pid"]))
            elif ty == "breakAlliance":
                rec = it.get("recipient")
                x = pid2p.get(rec)
                if x is not None:
                    triggers.append((t, x["cid"], "betrayed_by_ally", 30, a["pid"]))

    seen = set()
    for t0, vcid, scen, win, apid in triggers:
        dk = (vcid, apid, scen, int(t0 // 30))  # one trigger per attacker/victim/scenario per 30 s
        if dk in seen:
            continue
        seen.add(dk)
        grp = grp_of.get(vcid)
        b = bucket(t0)
        if grp is None or b is None:
            continue
        key = (scen, grp, b)
        counts[key]["n"] += 1
        evs = ev.get(vcid, [])
        att = pid2p.get(apid)
        acid = att["cid"] if att else None

        def within(w, kind, pred=lambda x: True):
            return any(t0 < te <= t0 + w and kind_ == kind and pred(x)
                       for te, kind_, x in evs)

        if within(win if scen != "alliance_req_received" else 30, "attack",
                  lambda x: x == apid):
            counts[key]["counter_attacker"] += 1
        if within(10, "attack"):
            counts[key]["counter_any"] += 1
        if any(t0 < te <= t0 + 30 and kind_ == "build" and x in DEF_UNITS for te, kind_, x in evs):
            counts[key]["defence_build"] += 1
        if within(30, "boat"):
            counts[key]["boat"] += 1
        if within(30, "req", lambda x: x == apid):
            counts[key]["request_back"] += 1
        triggers_n[scen] += 1

RESP_ORDER = ["counter_attacker", "counter_any", "defence_build", "boat", "request_back"]
os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
with open(os.path.join(HERE, "out", "scenarios.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["scenario", "group", "window", "n_triggers"] + RESP_ORDER)
    for (scen, grp, b), c in sorted(counts.items()):
        n = c["n"]
        w.writerow([scen, grp, b, n] + ["%.0f%%" % (100 * c[k] / n) if n else "" for k in RESP_ORDER])

print("games %d" % games)
print("%-22s %-5s %-10s %5s  %s" % ("scenario", "grp", "window", "n", "  ".join(RESP_ORDER)))
for (scen, grp, b), c in sorted(counts.items()):
    n = c["n"]
    print("%-22s %-5s %-10s %5d  %s" % (scen, grp, b, n,
          "  ".join("%3.0f%%" % (100 * c[k] / n) for k in RESP_ORDER)))
