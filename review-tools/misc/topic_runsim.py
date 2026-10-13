"""Run topic_sim.mts (v34 engine re-simulation) over downloaded replays in replays_world, N parallel, skipping done ones.
Only replays recorded on engine commit 3f5633b9 can be re-simulated deterministically; others are listed in sim/skipped.json.
Run: python -I world_runsim.py <parallel> [timeout_s]   (cwd irrelevant)"""
import json, os, re, sys, glob, subprocess, time, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__))
WD = os.path.join(HERE, "replays_world"); SIM = os.path.join(WD, "topic"); os.makedirs(SIM, exist_ok=True)
COMMIT = "3f5633b92c9508461e6e2b9e1f926487a1804c9f"
MAPS = {"World", "Giant World Map", "World Inverted"}
par = int(sys.argv[1]); tmo = int(sys.argv[2]) if len(sys.argv) > 2 else 2400
jobs, skipped = [], {}
for f in sorted([f for f in glob.glob(os.path.join(WD, "*.json")) if re.fullmatch(r"[A-Za-z0-9]{10}", os.path.basename(f)[:-5])]):
    gid = os.path.basename(f)[:-5]
    if os.path.exists(os.path.join(SIM, gid + ".json")): continue
    d = json.load(open(f, encoding="utf-8"))
    if d["info"]["config"]["gameMap"] not in MAPS: continue
    if d.get("gitCommit") != COMMIT: skipped[gid] = d.get("gitCommit"); continue
    jobs.append((gid, d["info"]["config"]["gameMap"], len(d["info"]["players"])))
print("jobs", len(jobs), "skipped (other commit)", len(skipped), flush=True)
TOP = {g["game_id"] for g in json.load(open(os.path.join(HERE, "top_player_games.json")))["games"]}
jobs.sort(key=lambda j: (j[0] not in TOP, -j[2]))  # top-player games first, then big
def run(j):
    gid = j[0]; t0 = time.time()
    try:
        r = subprocess.run(["cmd", "/c", "npx", "tsx", r"..\topic_sim.mts", os.path.join(WD, gid + ".json"), os.path.join(SIM, gid + ".json")],
                           cwd=os.path.join(HERE, "OF34"), capture_output=True, text=True, timeout=tmo)
        return gid, j[1], round(time.time() - t0), r.returncode, (r.stdout.strip() + r.stderr.strip())[-200:]
    except subprocess.TimeoutExpired:
        return gid, j[1], tmo, -9, "timeout"
with cf.ThreadPoolExecutor(par) as ex:
    for res in ex.map(run, jobs): print(*res, flush=True)
print("done", flush=True)
