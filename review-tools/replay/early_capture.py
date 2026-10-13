"""Early city/port study on v34 FFA replays: built vs captured vs held, and who captures were taken from.

Step 1 (run): picks the default-settings FFA 30+ games recorded on engine commit 3f5633b9 (ffa30_index.csv,
full or world rows; slim files have no turns and cannot be re-simulated), runs early_capture_sim.mts (OF34 engine,
2 processes at a time) and writes out/early_capture/<gid>.json. Resumable: finished games are skipped.
Step 2 (report): reads out/early_capture/*.json, writes out/early_capture/players.csv and captures.csv and
tools/replay_tools/early_capture_results.md (method, tables; the "## Conclusion" section is kept if present).

Run: python -I early_capture.py [parallel=2] [timeout_s=1500] [limit=0 (all)]
     python -I early_capture.py report
"""
import csv, glob, json, os, re, statistics as st, subprocess, sys, time, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out", "early_capture"); os.makedirs(OUT, exist_ok=True)
RESULTS = os.path.join(HERE, "early_capture_results.md")
COMMIT = "3f5633b92c9508461e6e2b9e1f926487a1804c9f"
CKS = [1800, 3000, 4200, 6000]  # 3, 5, 7, 10 min
CK_LABEL = {1800: "3 min", 3000: "5 min", 4200: "7 min", 6000: "10 min"}


def norm(n):
    return re.sub(r"^\[[^\]]*\]\s*", "", n or "").strip().lower()


def candidates():
    """Default-settings FFA 30+ games on commit 3f5633b9 with turns (ffa30_index.csv rows src full/world)."""
    rows = list(csv.DictReader(open(os.path.join(HERE, "out", "ffa30_index.csv"), encoding="utf-8")))
    top = json.load(open(os.path.join(TOOLS, "top_player_games.json"), encoding="utf-8"))
    topg = {g["game_id"] for g in top["games"]}
    seen, out = set(), []
    for r in rows:
        gid = r["gid"]
        if r["commit"] != COMMIT[:8] or r["src"] not in ("full", "world") or gid in seen:
            continue
        path = None
        for d in ("replays", "replays_world"):
            p = os.path.join(TOOLS, d, gid + ".json")
            if os.path.exists(p):
                path = p; break
        if path is None:
            continue
        seen.add(gid)
        out.append({"gid": gid, "path": path, "players": int(r["players"]), "map": r["map"],
                    "size": r["size"], "pro": gid in topg})
    out.sort(key=lambda g: (not g["pro"], -g["players"], g["gid"]))
    return out


def run_sims(parallel, timeout_s, limit):
    cands = candidates()
    todo = []
    for g in cands:
        if os.path.exists(os.path.join(OUT, g["gid"] + ".json")):
            continue
        d = json.load(open(g["path"], encoding="utf-8"))
        if d.get("gitCommit") != COMMIT:
            continue
        todo.append(g)
    if limit:
        todo = todo[:limit]
    print(f"candidates {len(cands)}, to run {len(todo)}, done before {len(cands) - len(todo)}", flush=True)
    def run(g):
        t0 = time.time()
        out = os.path.join(OUT, g["gid"] + ".json")
        try:
            r = subprocess.run(["cmd", "/c", "npx", "tsx", r"..\replay_tools\early_capture_sim.mts", g["path"], out],
                               cwd=os.path.join(TOOLS, "OF34"), capture_output=True, text=True, timeout=timeout_s)
            tail = (r.stdout.strip() + " " + r.stderr.strip())[-160:]
            return g["gid"], round(time.time() - t0), r.returncode, tail
        except subprocess.TimeoutExpired:
            return g["gid"], timeout_s, -9, "timeout"

    with cf.ThreadPoolExecutor(parallel) as ex:
        for res in ex.map(run, todo):
            print(*res, flush=True)
    print("sims done", flush=True)


def load_games():
    games = []
    for f in sorted(glob.glob(os.path.join(OUT, "*.json"))):
        if os.path.basename(f) in ("run.log",):
            continue
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if "cp" not in d:
            continue
        games.append(d)
    return games


def ranks(d):
    """Final rank per human small id: winner = 1, then alive at the end by tiles, then the dead by later death first."""
    fin = {row[0]: row for row in d["final"]}
    wcid = d.get("winnerCid")
    keyed = []
    for h in d["humans"]:
        row = fin[h["small"]]
        alive = row[10] == 1
        if h["cid"] == wcid:
            key = (3, 0)
        elif alive:
            key = (2, row[9])
        else:
            dt = h["deathTick"] if h["deathTick"] is not None else d["lastTurn"]
            key = (1, dt)
        keyed.append((key, h["small"]))
    keyed.sort(reverse=True)
    return {small: i + 1 for i, (_, small) in enumerate(keyed)}


def player_rows(d):
    """One dict per human per checkpoint, plus game-level winner/rank flags."""
    rk = ranks(d)
    hum = {h["small"]: h for h in d["humans"]}
    wsmall = next((h["small"] for h in d["humans"] if h["cid"] == d.get("winnerCid")), None)
    rows = []
    caps_by = {}
    for c in d["caps"]:
        if c["to"] in hum and c["held"] != -2:
            caps_by.setdefault(c["to"], []).append(c)
    for ck in CKS:
        for r in d["cp"].get(str(ck), []):
            s = r[0]
            h = hum[s]
            cc = [c for c in caps_by.get(s, []) if c["t"] <= ck]
            known = [c for c in cc if c["held"] in (0, 1)]
            rows.append({
                "gid": d["gid"], "map": d["map"], "size": d["size"], "nHumans": d["nHumans"], "ck": ck,
                "small": s, "cid": h["cid"], "name": h["name"], "winner": int(s == wsmall), "rank": rk[s],
                "bC": r[1], "bP": r[2], "cC": r[3], "cP": r[4], "lC": r[5], "lP": r[6], "oC": r[7], "oP": r[8],
                "tiles": r[9], "alive": r[10],
                "bT": r[1] + r[2], "cT": r[3] + r[4], "lT": r[5] + r[6], "oT": r[7] + r[8],
                "capEvents": len(cc), "capHeld": sum(1 for c in cc if c["held"] == 1),
                "capKnown": len(known),
            })
    return rows, rk, wsmall


def capture_rows(d, rk):
    hum = {h["small"] for h in d["humans"]}
    out = []
    for c in d["caps"]:
        if c["to"] not in hum:
            continue
        out.append({"gid": d["gid"], "map": d["map"], "t_s": round(c["t"] / 10, 1), "unit": c["u"], "lvl": c["lvl"],
                    "capturer": c["to"], "capturerRank": rk.get(c["to"]), "victim": c["from"],
                    "victimType": c["fromType"], "held3min": c["held"]})
    return out


def pct(x, n):
    return "-" if n == 0 else f"{100 * x / n:.0f}%"


def f1(x):
    return "-" if x is None else f"{x:.2f}"


def group_stats(rows, cond):
    out = {}
    for ck in CKS:
        sel = [r for r in rows if r["ck"] == ck and cond(r)]
        n = len(sel)
        if n == 0:
            out[ck] = None
            continue
        held = sum(r["capHeld"] for r in sel)
        known = sum(r["capKnown"] for r in sel)
        out[ck] = {
            "n": n,
            "bT": st.mean(r["bT"] for r in sel), "bC": st.mean(r["bC"] for r in sel), "bP": st.mean(r["bP"] for r in sel),
            "cT": st.mean(r["cT"] for r in sel), "lT": st.mean(r["lT"] for r in sel), "oT": st.mean(r["oT"] for r in sel),
            "cap1": sum(1 for r in sel if r["cT"] > 0) / n,
            "held": (held / known) if known else None, "heldN": held, "knownN": known,
        }
    return out


def paired(rows, metric):
    """Per game with a human winner: winner value minus median of the other humans in that game."""
    by = {}
    for r in rows:
        by.setdefault((r["gid"], r["ck"]), []).append(r)
    res = {}
    for ck in CKS:
        diffs = []
        for (gid, k), grp in by.items():
            if k != ck:
                continue
            w = [r for r in grp if r["winner"]]
            others = [r[metric] for r in grp if not r["winner"]]
            if not w or len(others) < 3:
                continue
            diffs.append(w[0][metric] - st.median(others))
        if not diffs:
            res[ck] = None
            continue
        res[ck] = {"n": len(diffs), "med": st.median(diffs), "mean": st.mean(diffs),
                   "gt": sum(1 for x in diffs if x > 0) / len(diffs), "eq": sum(1 for x in diffs if x == 0) / len(diffs),
                   "lt": sum(1 for x in diffs if x < 0) / len(diffs)}
    return res


def fmt_group_table(title, stats_by_group):
    lines = [f"### {title}", "",
             "| Checkpoint | Group | n | built C+P | captured C+P | lost C+P | owned C+P | >=1 capture | held (3 min later) |",
             "|---|---|---|---|---|---|---|---|---|"]
    for ck in CKS:
        for name, gs in stats_by_group:
            s = gs[ck]
            if s is None:
                lines.append(f"| {CK_LABEL[ck]} | {name} | 0 | - | - | - | - | - | - |")
                continue
            held = "-" if s["held"] is None else f"{100 * s['held']:.0f}% ({s['heldN']}/{s['knownN']})"
            lines.append(f"| {CK_LABEL[ck]} | {name} | {s['n']} | {s['bT']:.2f} (C {s['bC']:.2f} / P {s['bP']:.2f}) | "
                         f"{s['cT']:.2f} | {s['lT']:.2f} | {s['oT']:.2f} | {100 * s['cap1']:.0f}% | {held} |")
    lines.append("")
    return lines


def fmt_paired(title, pr):
    lines = [f"### {title}", "", "| Checkpoint | games | median diff | mean diff | winner above median | tied | below |",
             "|---|---|---|---|---|---|---|"]
    for ck in CKS:
        s = pr.get(ck)
        if s is None:
            lines.append(f"| {CK_LABEL[ck]} | 0 | - | - | - | - | - |"); continue
        lines.append(f"| {CK_LABEL[ck]} | {s['n']} | {s['med']:+.1f} | {s['mean']:+.2f} | {100 * s['gt']:.0f}% | "
                     f"{100 * s['eq']:.0f}% | {100 * s['lt']:.0f}% |")
    lines.append("")
    return lines


def fmt_sources(caps_all, label, cond):
    sel = [c for c in caps_all if cond(c)]
    n = len(sel)
    lines = [f"| {label} | captures | from HUMAN | from NATION | from BOT (tribe) | held 3 min later (all victims) | held from HUMAN | held from NATION | held from BOT |",
             "|---|---|---|---|---|---|---|---|---|"]
    if n == 0:
        lines.append(f"| {label} | 0 | - | - | - | - | - | - | - |")
        return lines
    cnt = {t: sum(1 for c in sel if c["victimType"] == t) for t in ("HUMAN", "NATION", "BOT")}
    def hr(xs):
        k = [c for c in xs if c["held3min"] in (0, 1)]
        return "-" if not k else f"{100 * sum(1 for c in k if c['held3min'] == 1) / len(k):.0f}% ({len(k)})"
    lines.append(f"| {label} | {n} | {pct(cnt['HUMAN'], n)} | {pct(cnt['NATION'], n)} | {pct(cnt['BOT'], n)} | "
                 f"{hr(sel)} | {hr([c for c in sel if c['victimType']=='HUMAN'])} | "
                 f"{hr([c for c in sel if c['victimType']=='NATION'])} | {hr([c for c in sel if c['victimType']=='BOT'])} |")
    return lines


def report():
    all_games = load_games()
    games = [d for d in all_games if d.get("sync")]
    n_unsync = len(all_games) - len(games)
    if not games:
        print("no hash-verified outputs yet"); return
    all_rows, all_caps = [], []
    val_rows = val_bad = 0
    winner_games = 0
    maps = {}
    for d in games:
        rows, rk, wsmall = player_rows(d)
        all_rows += rows
        all_caps += capture_rows(d, rk)
        if d.get("winnerCid"):
            winner_games += 1
        maps[d["map"]] = maps.get(d["map"], 0) + 1
        # validation: engine final stats vs the record's own end-of-game stats
        cid = {h["small"]: h["cid"] for h in d["humans"]}
        for f in d["final"]:
            r = d["rec"].get(cid[f[0]])
            if not r:
                continue
            val_rows += 1
            c = r["city"] + [0] * 4; p = r["port"] + [0] * 4
            ok = (f[1], f[2], f[3], f[4], f[5], f[6]) == (c[0], p[0], c[2], p[2], c[3], p[3])
            val_bad += 0 if ok else 1
    # Game-level CSVs
    with open(os.path.join(OUT, "players.csv"), "w", newline="", encoding="utf-8") as fh:
        keys = list(all_rows[0].keys())
        w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(all_rows)
    with open(os.path.join(OUT, "captures.csv"), "w", newline="", encoding="utf-8") as fh:
        keys = list(all_caps[0].keys()) if all_caps else ["gid"]
        w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(all_caps)

    rest = lambda r: not r["winner"]
    top3 = lambda r: r["rank"] <= 3
    low = lambda r: r["rank"] > 3
    groups = [("Winner", lambda r: bool(r["winner"])), ("Rest (non-winners)", rest),
              ("Top 3 (ranks 1-3)", top3), ("Ranks 4+", low)]
    gs = [(name, group_stats(all_rows, cond)) for name, cond in groups]
    pr_b = paired(all_rows, "bT"); pr_c = paired(all_rows, "cT"); pr_o = paired(all_rows, "oT")
    pr_cap = paired(all_rows, "capHeld")

    # Pro-presence subset (game lists a TrackerFront top player): winner vs rest
    pro_ids = {d["gid"] for d in games if d["gid"] in set(g["gid"] for g in candidates() if g["pro"])}
    pro_rows = [r for r in all_rows if r["gid"] in pro_ids]
    pro_gs = [("Winner", group_stats(pro_rows, lambda r: bool(r["winner"]))),
              ("Rest (non-winners)", group_stats(pro_rows, rest))]

    cap_groups = [
        ("Winner's captures", lambda c: c["capturerRank"] == 1),
        ("Top 3's captures (ranks 1-3)", lambda c: c["capturerRank"] is not None and c["capturerRank"] <= 3),
        ("Rest's captures (ranks 4+)", lambda c: c["capturerRank"] is not None and c["capturerRank"] > 3),
    ]
    sources_lines = ["| Capturer group | captures | from HUMAN | from NATION | from BOT (tribe) | held 3 min later (all) | held: from HUMAN | held: from NATION | held: from BOT |",
                     "|---|---|---|---|---|---|---|---|---|"]
    for name, cond in cap_groups:
        sel = [c for c in all_caps if cond(c)]
        n = len(sel)
        def hr(xs):
            k = [c for c in xs if c["held3min"] in (0, 1)]
            return "-" if not k else f"{100 * sum(1 for c in k if c['held3min'] == 1) / len(k):.0f}% ({len(k)})"
        cnt = {t: sum(1 for c in sel if c["victimType"] == t) for t in ("HUMAN", "NATION", "BOT")}
        sources_lines.append(f"| {name} | {n} | {pct(cnt['HUMAN'], n)} | {pct(cnt['NATION'], n)} | {pct(cnt['BOT'], n)} | "
                             f"{hr(sel)} | {hr([c for c in sel if c['victimType']=='HUMAN'])} | "
                             f"{hr([c for c in sel if c['victimType']=='NATION'])} | {hr([c for c in sel if c['victimType']=='BOT'])} |")
    sources_lines.append("")

    # Captures by time window (10 min pool): held and victim mix for winners in their first 3 min
    lines = []
    lines += ["# Early capture study: built vs captured vs held (v34 FFA replays)", ""]
    lines += ["## Method", "",
              "- Games: default-settings FFA 30+ replays with engine commit 3f5633b9 (the v34 build; ffa30_index.csv rows full/world; "
              "slim files have no turns). Re-simulated with the OF34 engine in `early_capture_sim.mts` (based on topic_sim.mts; "
              "`decompressGameRecord` fills sparse turns). 10 ticks = 1 s; checkpoints 3/5/7/10 min = ticks 1800/3000/4200/6000.",
              "- Built, captured, lost: the engine's own stats `units.city|port` index 0 (built), 2 (captured), 3 (lost), read at each checkpoint "
              "(StatsImpl.unitBuild / unitCapture / unitLose, called from UnitImpl.setOwner). Owned: active, not under construction.",
              "- Captures: every City/Port owner change (Unit update stream) in the first 10 min, with the victim type (HUMAN, NATION, BOT = bot or tribe). "
              "held = 1 if the same unit was still owned by the capturer 3 min after the capture, 0 otherwise (lost, destroyed or taken again). "
              "Captures whose 3-min check falls after the game ends are excluded from held rates. "
              "Pro-present games: games listed in top_player_games.json (a top player took part).",
              "- Winner: the record's winner (player). Rank: winner 1, then players alive at the end by tiles, then the dead by later death. "
              "Top 3 = ranks 1-3. Paired comparison: per game, winner value minus the median of the other humans' values in the same game.",
              "- Checks: sim hash checkpoints vs the record, and the sim's end-of-game engine stats vs the record's own stats.units (per player).",
              ""]
    lines += ["## Replay count", "",
              f"- Games analysed: {len(games)} (hash-verified in sync to the end; {n_unsync} out-of-sync outputs excluded); with a human winner: {winner_games}; "
              f"games with a pro (TrackerFront top list) player: {len(pro_ids)}.",
              f"- Players: {len(all_rows) // len(CKS)} human player records; captures in the first 10 min: {len(all_caps)} "
              f"(by any human capturer; {sum(1 for c in all_caps if c['held3min'] in (0,1))} with a known held state).",
              f"- Maps: " + ", ".join(f"{k} {v}" for k, v in sorted(maps.items(), key=lambda x: -x[1])) + ".",
              f"- Validation: engine end-of-game stats match the record for {val_rows - val_bad}/{val_rows} player rows (built, captured, lost, City and Port).",
              ""]
    lines += ["## Tables", "",
              "Means per player at each checkpoint (built/captured/lost/owned = City + Port, cumulative from the start of the game). "
              "\">=1 capture\" is the share of players with at least one capture so far. "
              "\"held\" = share of captures made so far that the capturer still owned 3 min later (count in brackets: held / known).", ""]
    lines += fmt_group_table("Winner vs the rest, Top 3 vs the rest", gs)
    lines += fmt_paired("Paired: winner minus the median other human in the same game (built C+P)", pr_b)
    lines += fmt_paired("Paired: winner minus the median other human, captured C+P", pr_c)
    lines += fmt_paired("Paired: winner minus the median other human, owned C+P", pr_o)
    lines += fmt_paired("Paired: winner minus the median other human, captures held 3 min later", pr_cap)
    lines += ["### Where the captures came from (all captures in the first 10 min, by human capturers)", ""] + sources_lines
    lines += fmt_group_table("Pro-present games only (TrackerFront top-player list)", pro_gs)
    lines += ["", "## Conclusion", ""]
    concl = None
    if os.path.exists(RESULTS):
        txt = open(RESULTS, encoding="utf-8").read()
        m = re.search(r"^## Conclusion\s*\n(.*)\Z", txt, re.S | re.M)
        if m and m.group(1).strip():
            concl = m.group(1).strip()
    if concl:
        lines[-1:] = []
        lines += [concl]
    else:
        lines += ["(to be written after the numbers are reviewed)"]
    open(RESULTS, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"wrote {RESULTS}: games {len(games)}, player rows {len(all_rows)}, captures {len(all_caps)}")


def main():
    args = sys.argv[1:]
    if args and args[0] == "report":
        report(); return
    parallel = int(args[0]) if len(args) > 0 else 2
    timeout_s = int(args[1]) if len(args) > 1 else 1500
    limit = int(args[2]) if len(args) > 2 else 0
    run_sims(parallel, timeout_s, limit)
    report()


if __name__ == "__main__":
    main()
