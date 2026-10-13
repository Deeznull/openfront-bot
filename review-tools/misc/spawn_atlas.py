"""Spawn atlas for the 4 ranked 1v1 maps (Australia, Iceland, Asia, EuropeClassic), Normal and Compact.
Pure python (no numpy). Usage:  python -I spawn_atlas.py [map ...]      (default: all four, ~3-6 min)
Reads  OpenFrontIO-ranked/resources/maps/<map>/{manifest.json,map.bin,map4x.bin}  (read-only).
Writes spawn_atlas.json (picks, regions) and spawn_atlas_img/<map>_<variant>.png (marked overview maps).

Facts used (checked in the engine source):
- Normal = map.bin, Compact = map4x.bin (half width/height, ~1/4 tiles). Tribe count 400 vs 100, so tribes per land
  tile is about the same in both variants (a tribe every ~2700-3300 land tiles, ~55 tiles apart).
- Terrain byte: bit7 land, bit6 shoreline, bit5 ocean, bits0-4 magnitude (31 = impassable land: not ownable, a wall).
- Spawn disc radius 4 (Util.ts). Land is connected 4-neighbour.
Scoring (0-100) per candidate cell (cell = 10 tiles Normal, 5 tiles Compact):
  reach  (15): land tiles reachable on foot within 200 tiles of path (cell BFS), saturating at 50k tiles (diamond of radius 200 = 80k)
  pocket (15): land in the pocket delimited by narrow necks (strips < 20 tiles wide), saturating at 60k tiles
  coast  (20): ocean-coast within 12 tiles = full, fades to 0 at 72 tiles (needed for the 1% boats)
  expo   (20): land fraction in the +-100 and +-60 tile boxes: 0.40-0.55 best (convex coast); 0.85+ = ringed by Tribes; <0.25 = tiny pocket
  neck   (10): share of the reach that stays reachable without crossing narrow land (strip < ~20 tiles wide)
  boat   (20): on the largest landmass 0.5 + 0.5 x (land across water within 250 tiles, saturating 15k); on other landmasses fades with the water gap (0 at 300 tiles)
"""
import os, sys, json, zlib, struct, math
from array import array
from collections import Counter, deque

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "OpenFrontIO-ranked", "resources", "maps")
OUT_IMG = os.path.join(HERE, "spawn_atlas_img")
MAPS = {"Australia": "australia", "Iceland": "iceland", "Asia": "asia", "EuropeClassic": "europeclassic"}
BOTS = {"normal": 400, "compact": 100}
BOX_R = 100       # tiles, exposure box half-size
REACH_R = 200     # tiles, walking reach radius
NECK_HW = int(os.environ.get("NECK_HW", "10"))      # tiles: half-width below this = narrow land


def load(key, variant):
    d = os.path.join(ROOT, key)
    man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    meta = man["map"] if variant == "normal" else man["map4x"]
    raw = open(os.path.join(d, "map.bin" if variant == "normal" else "map4x.bin"), "rb").read()
    w, h = meta["width"], meta["height"]
    assert len(raw) == w * h, (len(raw), w, h)
    div = 1 if variant == "normal" else 2
    nations = [(n["name"], n["coordinates"][0] // div, n["coordinates"][1] // div) for n in man["nations"] if n.get("coordinates")]
    return w, h, raw, nations, meta["num_land_tiles"]


def analyse(key, variant):
    w, h, raw, nations, manifest_land = load(key, variant)
    PW = w + 2
    N = PW * (h + 2)
    cls = bytearray([2]) * N                      # 0 water, 1 land, 2 wall/pad
    oc = bytearray(N)                             # water tile with ocean bit
    for y in range(h):
        base = (y + 1) * PW + 1
        row = raw[y * w:(y + 1) * w]
        seg = bytearray(w)
        o = bytearray(w)
        for x, b in enumerate(row):
            if b & 128:
                seg[x] = 2 if (b & 31) == 31 else 1
            else:
                seg[x] = 0
                if b & 32: o[x] = 1
        cls[base:base + w] = seg
        oc[base:base + w] = o
    total_land = cls.count(1)
    # --- connected land regions (4-neighbour)
    lab = array("i", [0]) * N
    sizes = [0]
    nb = (1, -1, PW, -PW)
    for s in range(N):
        if cls[s] == 1 and lab[s] == 0:
            L = len(sizes); lab[s] = L; st = [s]; cnt = 0
            while st:
                i = st.pop(); cnt += 1
                for d in nb:
                    j = i + d
                    if cls[j] == 1 and lab[j] == 0:
                        lab[j] = L; st.append(j)
            sizes.append(cnt)
    main_lab = max(range(1, len(sizes)), key=lambda l: sizes[l])
    # --- coast tiles (land next to ocean water), and distance to any water (for half-width)
    dist = array("H", [0]) * N
    coast_oc = bytearray(N)
    fr = []
    for i in range(N):
        if cls[i] == 1:
            a = False; o = False
            for d in nb:
                j = i + d
                if cls[j] != 1:
                    a = True
                    if cls[j] == 0 and oc[j]: o = True
            if a:
                dist[i] = 1; fr.append(i)
            if o: coast_oc[i] = 1
    dcur = 1
    while fr:
        dcur += 1; nf = []
        for i in fr:
            for d in nb:
                j = i + d
                if cls[j] == 1 and dist[j] == 0:
                    dist[j] = dcur; nf.append(j)
        fr = nf
    # --- coarse cells
    B = 10 if variant == "normal" else 5
    cw, ch = (w + B - 1) // B, (h + B - 1) // B
    nc = cw * ch
    land_c = [0] * nc; coast_c = [0] * nc; maxd = [0] * nc
    lab_cnt = [None] * nc
    for y in range(h):
        cy = y // B
        base = (y + 1) * PW + 1
        for x in range(w):
            i = base + x
            if cls[i] == 1:
                c = cy * cw + x // B
                land_c[c] += 1
                if coast_oc[i]: coast_c[c] += 1
                dd = dist[i]
                if dd > maxd[c]: maxd[c] = dd
                if (x & 1) == 0 and (y & 1) == 0:
                    t = lab_cnt[c]
                    if t is None: t = lab_cnt[c] = {}
                    l = lab[i]; t[l] = t.get(l, 0) + 1
    domlab = [0] * nc
    for c in range(nc):
        t = lab_cnt[c]
        if t: domlab[c] = max(t, key=t.get)
    passable = [land_c[c] >= 0.15 * B * B for c in range(nc)]
    # window max of half-width (+-20 tiles) for neck detection
    k = max(1, round(20 / B))
    def maxfilt(a, horizontal):
        out = [0] * nc
        for y in range(ch):
            for x in range(cw):
                m = 0
                if horizontal:
                    for xx in range(max(0, x - k), min(cw, x + k + 1)):
                        v = a[y * cw + xx]
                        if v > m: m = v
                else:
                    for yy in range(max(0, y - k), min(ch, y + k + 1)):
                        v = a[yy * cw + x]
                        if v > m: m = v
                out[y * cw + x] = m
        return out
    hw = maxfilt(maxfilt(maxd, True), False)
    wide = [passable[c] and hw[c] >= NECK_HW for c in range(nc)]
    # neck-delimited pockets: 4-connected components of wide cells
    wl = [0] * nc; wsz = [0]
    for c0 in range(nc):
        if wide[c0] and wl[c0] == 0:
            L = len(wsz); wl[c0] = L; st = [c0]; tot_ = 0
            while st:
                c = st.pop(); tot_ += land_c[c]; x, y = c % cw, c // cw
                for j in ((c + 1) if x + 1 < cw else -1, (c - 1) if x > 0 else -1, (c + cw) if y + 1 < ch else -1, (c - cw) if y > 0 else -1):
                    if j >= 0 and wide[j] and wl[j] == 0:
                        wl[j] = L; st.append(j)
            wsz.append(tot_)
    def pocket_of(cx, cy):
        best = 0
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                x, y = cx + dx, cy + dy
                if 0 <= x < cw and 0 <= y < ch and wl[y * cw + x]:
                    best = max(best, wsz[wl[y * cw + x]])
        return best
    # land prefix sums for box exposure
    ps = [[0] * (cw + 1) for _ in range(ch + 1)]
    for y in range(ch):
        run = 0
        for x in range(cw):
            run += land_c[y * cw + x]
            ps[y + 1][x + 1] = ps[y][x + 1] + run
    psm = [[0] * (cw + 1) for _ in range(ch + 1)]       # land of the largest landmass only
    for y in range(ch):
        run = 0
        for x in range(cw):
            c = y * cw + x
            if domlab[c] == main_lab: run += land_c[c]
            psm[y + 1][x + 1] = psm[y][x + 1] + run
    def box_sum(P, cx, cy, R_):
        r = R_ // B
        x0, x1, y0, y1 = max(0, cx - r), min(cw, cx + r + 1), max(0, cy - r), min(ch, cy + r + 1)
        return P[y1][x1] - P[y0][x1] - P[y1][x0] + P[y0][x0]
    def box_frac(cx, cy, R_=None):
        r = (R_ or BOX_R) // B
        x0, x1, y0, y1 = max(0, cx - r), min(cw, cx + r + 1), max(0, cy - r), min(ch, cy + r + 1)
        area = (min(w, x1 * B) - x0 * B) * (min(h, y1 * B) - y0 * B)
        s = ps[y1][x1] - ps[y0][x1] - ps[y1][x0] + ps[y0][x0]
        return s / max(1, area)
    # coast distance (cells) and boat gap via multi-source BFS in cells
    INF = 10 ** 9
    cdist = [INF] * nc
    dq = deque()
    for c in range(nc):
        if coast_c[c] > 0:
            cdist[c] = 0; dq.append(c)
    while dq:
        c = dq.popleft(); x, y = c % cw, c // cw
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            xx, yy = x + dx, y + dy
            if 0 <= xx < cw and 0 <= yy < ch:
                j = yy * cw + xx
                if passable[j] and cdist[j] == INF:
                    cdist[j] = cdist[c] + 1; dq.append(j)
    main = max(range(1, len(sizes)), key=lambda l: sizes[l])
    gap = [INF] * nc
    for c in range(nc):
        if passable[c] and domlab[c] == main:
            gap[c] = 0; dq.append(c)
    while dq:
        c = dq.popleft(); x, y = c % cw, c // cw
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                xx, yy = x + dx, y + dy
                if (dx or dy) and 0 <= xx < cw and 0 <= yy < ch:
                    j = yy * cw + xx
                    if gap[j] == INF:
                        gap[j] = gap[c] + 1; dq.append(j)
    comp_gap = {}
    for c in range(nc):
        if passable[c] and domlab[c]:
            l = domlab[c]; comp_gap[l] = min(comp_gap.get(l, INF), gap[c] * B)
    # geodesic reach (cell BFS, 4-neighbour, depth REACH_R/B) all vs wide-only
    depth = REACH_R // B
    stamp = [-1] * nc
    def reach(start, only_wide, sid):
        if only_wide and not wide[start]: return land_c[start], None
        tot = 0; frontier = [start]; stamp[start] = sid; d = 0; first_narrow = None
        while frontier and d <= depth:
            nf = []
            for c in frontier:
                tot += land_c[c]
                x, y = c % cw, c // cw
                for j in ((c + 1) if x + 1 < cw else -1, (c - 1) if x > 0 else -1, (c + cw) if y + 1 < ch else -1, (c - cw) if y > 0 else -1):
                    if j >= 0 and stamp[j] != sid and passable[j] and (not only_wide or wide[j]):
                        stamp[j] = sid; nf.append(j)
                        if first_narrow is None and not wide[j] and not only_wide: first_narrow = (d + 1) * B
            frontier = nf; d += 1
        return tot, first_narrow
    sid = [0]
    def cand_at(cx, cy):
        c = cy * cw + cx
        if not (0 <= cx < cw and 0 <= cy < ch) or not passable[c] or land_c[c] < 0.4 * B * B: return None
        l = domlab[c]
        if l == 0: return None
        sid[0] += 1; ra, nk = reach(c, False, sid[0])
        sid[0] += 1; rw, _ = reach(c, True, sid[0])
        cd = cdist[c] * B
        pk = pocket_of(cx, cy) or ra
        f = box_frac(cx, cy)
        f60 = box_frac(cx, cy, 60)
        g = 0 if l == main else comp_gap.get(l, 400)
        s_reach = min(1.0, ra / 50000)
        s_coast = 1.0 if cd <= 12 else max(0.0, 1 - (cd - 12) / 60)
        def ex1(v):
            if 0.40 <= v <= 0.55: return 1.0
            if v > 0.55: return max(0.0, 1 - (v - 0.55) / 0.30)
            return max(0.0, (v - 0.15) / 0.25)
        s_exp = 0.5 * ex1(f) + 0.5 * ex1(f60)
        s_neck = min(1.0, rw / max(1, ra))
        s_pocket = min(1.0, pk / 60000)
        tot_box = box_sum(ps, cx, cy, 250); main_box = box_sum(psm, cx, cy, 250)
        other = (tot_box - main_box) if l == main else main_box   # land across water within ~250 tiles = boat targets
        sea = min(1.0, other / 15000)
        s_boat = (0.5 + 0.5 * sea) if l == main else max(0.0, 1 - g / 300)
        score = 100 * (0.15 * s_reach + 0.15 * s_pocket + 0.20 * s_coast + 0.20 * s_exp + 0.10 * s_neck + 0.20 * s_boat)
        return dict(c=c, cx=cx, cy=cy, x=cx * B + B // 2, y=cy * B + B // 2, lab=l, comp_pct=100 * sizes[l] / total_land,
                    reach=ra, wide_reach=rw, pocket=pk, pocket_pct=100 * pk / total_land, coast_d=cd, box_land=f, box60=f60, boat_targets=other, gap=g, neck_d=nk, score=score,
                    s=dict(pocket=s_pocket, reach=s_reach, coast=s_coast, expo=s_exp, neck=s_neck, boat=s_boat))
    cands = [r for r in (cand_at(cx, cy) for cy in range(ch) for cx in range(cw)) if r]
    return dict(key=key, variant=variant, w=w, h=h, B=B, cw=cw, ch=ch, total_land=total_land, manifest_land=manifest_land,
                walls=cls.count(2) - (2 * PW + 2 * h), sizes=sizes, main=main, nations=nations, cands=cands, cand_at=cand_at,
                wl=wl, wsz=wsz, land_c=land_c, coast_c=coast_c, domlab=domlab, passable=passable, comp_gap=comp_gap,
                tiles=(cls, dist, coast_oc, PW))


def pick(R):
    cands = R["cands"]; w = R["w"]
    sep = 0.18 * w
    def far(c, chosen):
        return all(math.hypot(c["x"] - o["x"], c["y"] - o["y"]) >= sep for o in chosen)
    # GOOD: best score, coastal, big landmass
    good = []
    pool = sorted([c for c in cands if c["coast_d"] <= 20 and c["comp_pct"] >= 3 and c["pocket_pct"] >= 5], key=lambda c: (-round(c["score"]), abs(c["box_land"] - 0.55), -c["reach"]))
    for c in pool:
        if far(c, good):
            c = dict(c); c["kind"] = "GOOD"; good.append(c)
        if len(good) == 3: break
    # DEATH TRAPS: tiny pocket (small walking reach / small landmass) and ringed interior (box full of land, far from coast)
    traps = []
    tiny = sorted([c for c in cands if c["reach"] >= 2500 or c["comp_pct"] >= 0.3], key=lambda c: (c["reach"], -c["comp_pct"]))
    for c in tiny:
        if c["reach"] < 15000 and c["coast_d"] <= 30:
            c = dict(c); c["kind"] = "TRAP-pocket"; traps.append(c); break
    ringed = sorted([c for c in cands if c["comp_pct"] >= 3], key=lambda c: -(c["box_land"] * 100 + min(c["coast_d"], 150) * 0.5))
    for c in ringed:
        if far(c, traps + good):
            c = dict(c); c["kind"] = "TRAP-ringed/inland"; traps.append(c); break
    # a third class when the first found nothing: thinnest neck on a big landmass
    if len(traps) < 2:
        neck = sorted([c for c in cands if c["comp_pct"] >= 3 and c["coast_d"] <= 20], key=lambda c: c["s"]["neck"])
        for c in neck:
            if far(c, traps + good):
                c = dict(c); c["kind"] = "TRAP-neck"; traps.append(c)
            if len(traps) == 2: break
    return good, traps


def refine(R, p):
    """Find an actual coast spawn tile near the cell centre: land, ocean coast within 3-8 tiles, plains if possible."""
    cls, dist, coast_oc, PW = R["tiles"]; w, h = R["w"], R["h"]
    best = None
    rad = R["B"] * 2
    for dy in range(-rad, rad + 1):
        for dx in range(-rad, rad + 1):
            x, y = p["x"] + dx, p["y"] + dy
            if 0 <= x < w and 0 <= y < h:
                i = (y + 1) * PW + x + 1
                if cls[i] == 1 and 3 <= dist[i] <= 8:
                    sc = abs(dx) + abs(dy)
                    if best is None or sc < best[0]: best = (sc, x, y)
    return (best[1], best[2]) if best else (p["x"], p["y"])


def compass(dx, dy):
    if dx == 0 and dy == 0: return "at"
    a = math.degrees(math.atan2(-dy, dx)) % 360
    return ["E", "NE", "N", "NW", "W", "SW", "S", "SE"][int(((a + 22.5) % 360) // 45)]


def sea_dir(R, x, y):
    cls, dist, coast_oc, PW = R["tiles"]; w, h = R["w"], R["h"]
    sx = sy = n = 0
    for dy in range(-40, 41, 2):
        for dx in range(-40, 41, 2):
            xx, yy = x + dx, y + dy
            if 0 <= xx < w and 0 <= yy < h and cls[(yy + 1) * PW + xx + 1] == 0:
                sx += dx; sy += dy; n += 1
    return compass(sx, sy) if n > 10 else "none"


# ---- tiny PNG writer + digit font for the marked maps
FONT = {"0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
        "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111",
        "G": "111100101101111", "T": "111010010010010"}
def png(path, W, H, rgb):
    raw = b"".join(b"\x00" + bytes(rgb[y * W * 3:(y + 1) * W * 3]) for y in range(H))
    def ch(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b""))


def render(R, good, traps, zoom=5):
    cw, ch_, B = R["cw"], R["ch"], R["B"]
    W, H = cw * zoom, ch_ * zoom
    rgb = bytearray(W * H * 3)
    pal = [(150, 195, 225), (60, 150, 60), (235, 200, 80), (200, 120, 60), (170, 120, 200), (90, 190, 190), (200, 90, 140), (120, 120, 120)]
    order = sorted(range(1, len(R["sizes"])), key=lambda l: -R["sizes"][l])
    rank = {l: i for i, l in enumerate(order)}
    for cy in range(ch_):
        for cx in range(cw):
            c = cy * cw + cx
            col = (25, 55, 110)
            if R["land_c"][c] >= 0.15 * B * B and R["domlab"][c]:
                if rank[R["domlab"][c]] == 0: col = (70, 150, 70)
                else: col = pal[1 + (rank[R["domlab"][c]] % 6)]
                if R["coast_c"][c] == 0: col = tuple(int(v * 0.75) for v in col)
            for yy in range(zoom):
                o = ((cy * zoom + yy) * W + cx * zoom) * 3
                rgb[o:o + zoom * 3] = bytes(col) * zoom
    for k in range(1, 10):                          # 10% grid
        for t in range(0, W):
            y = H * k // 10
            o = (y * W + t) * 3
            if t % 3 == 0: rgb[o:o + 3] = b"\xff\xff\xff"
        for t in range(0, H):
            x = W * k // 10
            o = (t * W + x) * 3
            if t % 3 == 0: rgb[o:o + 3] = b"\xff\xff\xff"
    for (_, nx, ny) in R["nations"]:
        px, py = nx * W // R["w"], ny * H // R["h"]
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if 0 <= px + dx < W and 0 <= py + dy < H: rgb[((py + dy) * W + px + dx) * 3:((py + dy) * W + px + dx) * 3 + 3] = b"\xff\xff\x00"
    def label(txt, x0, y0):
        for gi, glyph in enumerate(txt):
            for r in range(5):
                for q in range(3):
                    if FONT[glyph][r * 3 + q] == "1":
                        x, y = x0 + gi * 5 + q * 2, y0 + r * 2
                        for sy in range(2):
                            for sx in range(2):
                                if 0 <= x + sx < W and 0 <= y + sy < H: rgb[((y + sy) * W + x + sx) * 3:((y + sy) * W + x + sx) * 3 + 3] = bytes((255, 255, 64))
    for k in range(1, 10):
        label(str(k * 10), W * k // 10 + 2, 2)
        label(str(k * 10), 2, H * k // 10 + 2)
    def mark(p, ch, col):
        px, py = p["rx"] * W // R["w"], p["ry"] * H // R["h"]
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                x, y = px + dx, py + dy
                if 0 <= x < W and 0 <= y < H: rgb[(y * W + x) * 3:(y * W + x) * 3 + 3] = bytes(col)
        for gi, glyph in enumerate(ch):
            for r in range(5):
                for q in range(3):
                    if FONT[glyph][r * 3 + q] == "1":
                        for sy in range(2):
                            for sx in range(2):
                                x, y = px - 5 + gi * 8 + q * 2 + sx, py - 5 + r * 2 + sy
                                if 0 <= x < W and 0 <= y < H: rgb[(y * W + x) * 3:(y * W + x) * 3 + 3] = b"\x00\x00\x00"
    for i, p in enumerate(good): mark(p, "G" + str(i + 1), (80, 255, 80))
    for i, p in enumerate(traps): mark(p, "T" + str(i + 1), (255, 70, 70))
    os.makedirs(OUT_IMG, exist_ok=True)
    png(os.path.join(OUT_IMG, f"{R['key'].lower()}_{R['variant']}.png"), W, H, rgb)


def main():
    keys = [k for k in MAPS if not sys.argv[1:] or k in sys.argv[1:]]
    out = {}
    for key in keys:
        for variant in ("normal", "compact"):
            R = analyse(MAPS[key], variant)
            good, traps = pick(R)
            tot = R["total_land"]
            regs = sorted(range(1, len(R["sizes"])), key=lambda l: -R["sizes"][l])[:8]
            rj = []
            cells = {}
            for c in range(R["cw"] * R["ch"]):
                l = R["domlab"][c]
                if l in regs: cells.setdefault(l, []).append(c)
            for l in regs:
                cs = cells.get(l, [])
                mx = sum(c % R["cw"] for c in cs) / max(1, len(cs)) * R["B"]; my = sum(c // R["cw"] for c in cs) / max(1, len(cs)) * R["B"]
                rj.append(dict(pct=round(100 * R["sizes"][l] / tot, 2), tiles=R["sizes"][l], cx_pct=round(100 * mx / R["w"], 1), cy_pct=round(100 * my / R["h"], 1),
                               boat_gap_to_main=0 if l == R["main"] else R["comp_gap"].get(l)))
            wr = []
            wc = {}
            for c in range(R["cw"] * R["ch"]):
                if R["wl"][c]: wc.setdefault(R["wl"][c], []).append(c)
            for l in sorted(wc, key=lambda l: -R["wsz"][l])[:8]:
                cs = wc[l]
                wr.append(dict(pct=round(100 * R["wsz"][l] / tot, 2), cx_pct=round(100 * sum(c % R["cw"] for c in cs) / len(cs) * R["B"] / R["w"], 1),
                               cy_pct=round(100 * sum(c // R["cw"] for c in cs) / len(cs) * R["B"] / R["h"], 1)))
            for p in good + traps:
                p["rx"], p["ry"] = refine(R, p)
                p["x_pct"], p["y_pct"] = round(100 * p["rx"] / R["w"], 1), round(100 * p["ry"] / R["h"], 1)
                nn = min(R["nations"], key=lambda n: math.hypot(n[1] - p["rx"], n[2] - p["ry"]))
                p["near"] = f"{nn[0]} marker {compass(p['rx'] - nn[1], p['ry'] - nn[2])} {int(math.hypot(nn[1] - p['rx'], nn[2] - p['ry']))} tiles"
                p["sea_dir"] = sea_dir(R, p["rx"], p["ry"])
                p["tribes_in_reach"] = round(p["reach"] / (tot / BOTS[variant]), 1)
            render(R, good, traps)
            print(f"\n=== {key} {variant}: {R['w']}x{R['h']}, land {tot} (manifest {R['manifest_land']}), walls(impassable) {R['walls']}")
            for r in rj[:6]: print("  region", r)
            for r in wr[:6]: print("  neck-pocket", r)
            for p in good + traps:
                print(f"  {p['kind']:<18} tile ({p['rx']},{p['ry']}) = ({p['x_pct']}%,{p['y_pct']}%) score {p['score']:.0f} comp {p['comp_pct']:.1f}% reach {p['reach']} (~{p['tribes_in_reach']} tribes) pocket {p['pocket_pct']:.1f}% "
                      f"wide {p['wide_reach']} coast_d {p['coast_d']} box_land {p['box_land']:.2f} gap {p['gap']} sea {p['sea_dir']} | {p['near']}")
            out[f"{key}_{variant}"] = dict(w=R["w"], h=R["h"], land=tot, regions=rj, neck_pockets=wr,
                                           picks=[{k: v for k, v in p.items() if k not in ("c", "cx", "cy", "lab")} for p in good + traps])
            sys.stdout.flush()
    path = os.path.join(HERE, "spawn_atlas.json")
    old = json.load(open(path)) if os.path.exists(path) and sys.argv[1:] else {}
    old.update(out)
    json.dump(old, open(path, "w"), indent=1)


if __name__ == "__main__":
    main()
