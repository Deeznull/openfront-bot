"""RP2 extra measures: cap behaviour, long wars, far/wild boat seeds, allies vs open fronts.
usage: python tools/rp2_extra.py  (reads tools/replays/state2/*.state.json + tools/replays/<id>.json)"""
import json, glob, os, statistics as st, collections, sys
R = os.path.join(os.path.dirname(__file__), 'replays')
GAMES = ['cboH5FnC2C','cP7ZSWJmaB','cwC2ePQW5r','cpSnhwx1gW','cAbJjEnvfF','cFvb4MzK2V','ctaYosHkfS','cdn6SnPDLm','ckBpXCXJHC','cDdxe79See','cFzeBcD9SD','cPWYjmAWDE']
def mmss(t): return '%d:%02d' % (int(t)//60, int(t)%60)
def med(x): return round(st.median(x),1) if x else None
out = []
for gid in GAMES:
    d = json.load(open(os.path.join(R,'state2',gid+'.state.json')))
    m = d['meta']; ev = d['events']; sm = d['samples']
    raw = json.load(open(os.path.join(R,gid+'.json')))
    cid = m['clientID']
    P = print
    P('=== %s %s | %s | dur %ss' % (gid, m['map'], m['me'], m['duration']))
    # ---- 1 cap behaviour
    spl = [s for s in sm if s['t']>=60]
    cap = [s for s in spl if s['troops']>=0.9*s['maxTroops']]
    hi = [s for s in spl if s['troops']>=0.8*s['maxTroops']]
    idle = [s for s in cap if s['outAtk']==0]
    P('CAP: samples>=60s %d | >=90%% cap %d (%.0f%%) | >=80%% %d (%.0f%%) | of >=90%% samples with NO outgoing attack: %d (%.0f%%)' % (
        len(spl), len(cap), 100*len(cap)/max(1,len(spl)), len(hi), 100*len(hi)/max(1,len(spl)), len(idle), 100*len(idle)/max(1,len(cap))))
    ca = [e for e in ev if e.get('maxTroops') and e['t']>=60 and e['troops']>=0.9*e['maxTroops']]
    ct = collections.Counter(e['type'] for e in ca if e['type'] in ('attack','boat','build_unit','allianceRequest','allianceExtension','NUKE_OUT','embargo','breakAlliance'))
    bs = [100*e['sent']/e['troops'] for e in ca if e['type']=='boat']
    at = [100*e['sent']/e['troops'] for e in ca if e['type']=='attack']
    allat = [100*e['sent']/e['troops'] for e in ev if e['type']=='attack' and e['t']>=60 and e.get('troops')]
    allbt = [100*e['sent']/e['troops'] for e in ev if e['type']=='boat' and e['t']>=60 and e.get('troops')]
    P('  actions while troops>=90%% cap: %s | attack sent%% med at-cap %s vs overall %s | boat sent%% med at-cap %s vs overall %s' % (dict(ct), med(at), med(allat), med(bs), med(allbt)))
    # recalls
    rc = []
    for t in raw['turns']:
        for i in t.get('intents',[]):
            if i.get('clientID')==cid and i['type']=='cancel_boat':
                rc.append(mmss((t.get('turnNumber',0)-200)/10))
    ra = []
    for t in raw['turns']:
        for i in t.get('intents',[]):
            if i.get('clientID')==cid and i['type']=='cancel_attack':
                ra.append(mmss((t.get('turnNumber',0)-200)/10))
    P('  cancel_boat (recall) by me: %d %s | cancel_attack: %d %s' % (len(rc), rc[:8], len(ra), ra[:8]))
    # ---- 2 wars: human target streaks gap<=60s
    atks = [e for e in ev if e['type']=='attack' and e['target']['type']=='human']
    by = collections.defaultdict(list)
    for e in atks: by[e['target']['name']].append(e)
    wars = []
    for name, L in by.items():
        L.sort(key=lambda e:e['t'])
        s = 0
        for i in range(1,len(L)+1):
            if i==len(L) or L[i]['t']-L[i-1]['t']>90:
                seg = L[s:i]
                if len(seg)>=3: wars.append((seg[-1]['t']-seg[0]['t'], name, seg))
                s = i
    wars.sort(key=lambda w:-w[0])
    allied_after = {}
    for e in ev:
        if e['type']=='ALLIED': allied_after.setdefault(e['other']['name'],[]).append(e['t'])
    P('WARS (human target, >=3 attacks, gaps<=90s): %d; top 4 by length' % len(wars))
    for dur,name,seg in wars[:4]:
        t0,t1 = seg[0]['t'], seg[-1]['t']
        tg0 = seg[0]['target'].get('tiles'); tg1 = seg[-1]['target'].get('tiles')
        # end: dead? alliance after? just stopped?
        al = [t for t in allied_after.get(name,[]) if t1-30 <= t <= t1+90]
        later = [e for e in atks if e['target']['name']==name and e['t']>t1+90]
        last = seg[-1]['target']['tiles']
        end = 'allied %s' % mmss(al[0]) if al else ('target tiles %s->%s' % (tg0, tg1))
        # defender dead? check ALLY_ENDED ally_died
        died = [e for e in ev if e['type']=='ALLY_ENDED' and e['name']==name and e.get('how')=='ally_died']
        P('   %s %s %s-%s %.0fs n=%d sent%% med %s | tgt tiles %s -> %s | me tiles %s -> %s | %s%s%s' % (
            name[:18], '', mmss(t0), mmss(t1), dur, len(seg), med([100*e['sent']/e['troops'] for e in seg]), tg0, tg1, seg[0]['tiles'], seg[-1]['tiles'], end,
            ' | resumed later %d' % len(later) if later else '', ' | died' if died else ''))
    # ---- 3 boats: wild / far seeds
    bo = [e for e in ev if e['type']=='boat']
    wild = [e for e in bo if e['target']['type']=='wild']
    far = [e for e in bo if e.get('dstDist',0)>=300]
    wild_late = [e for e in wild if e['t']>=60]
    P('BOATS: total %d | to wilderness %d (after 1:00: %d, times %s) | dst>=300 tiles from home %d (after 1:00 %d) | wild+far(>=300) after 1:00: %d' % (
        len(bo), len(wild), len(wild_late), [mmss(e['t']) for e in wild_late[:10]], len(far), len([e for e in far if e['t']>=60]), len([e for e in bo if e['t']>=60 and (e['target']['type']=='wild' or e.get('dstDist',0)>=300)])))
    far_b = [e for e in ev if e['type']=='build_unit' and e.get('dCentroid',0)>=400 and e['unit'] in ('City','Port','Factory','Missile Silo','SAM Launcher','Defense Post')]
    P('  far builds (dCentroid>=400): %d of %d structure buys; first 5: %s' % (len(far_b), len([e for e in ev if e['type']=='build_unit' and e['unit'] in ('City','Port','Factory','Missile Silo','SAM Launcher','Defense Post')]), [(mmss(e['t']), e['unit'], e['dCentroid']) for e in far_b[:5]]))
    # ---- 4 allies vs open fronts per minute
    P('ALLIES vs FRONTS (min: allies / attacks / boats / builds / ally-reqs / land%%): ')
    end_t = m['duration']
    rows = []
    for mi in range(0, int(end_t//60)+1):
        a = [s for s in sm if mi*60 <= s['t'] < (mi+1)*60]
        if not a: continue
        al = max(len(s['allies']) for s in a)
        na = len([e for e in ev if e['type']=='attack' and mi*60<=e['t']<(mi+1)*60 and e['target']['type'] in ('human','Nation')])
        nb = len([e for e in ev if e['type']=='boat' and mi*60<=e['t']<(mi+1)*60])
        nbd = len([e for e in ev if e['type']=='build_unit' and mi*60<=e['t']<(mi+1)*60])
        nr = len([e for e in ev if e['type']=='allianceRequest' and mi*60<=e['t']<(mi+1)*60])
        lp = a[-1]['landPct']
        rows.append((mi, al, na, nb, nbd, nr, lp))
    P('   ' + ' | '.join('%d:%da/%dat/%db/%dbd' % (r[0], r[1], r[2], r[3], r[4]) for r in rows))
    boxed = [r for r in rows if r[1]>=5 and r[2]<=1]
    P('   boxed-by-allies minutes (>=5 allies, <=1 land attack): %d of %d minutes with >=5 allies; in them: boats %d, builds %d, ally-reqs %d' % (
        len(boxed), len([r for r in rows if r[1]>=5]), sum(r[3] for r in boxed), sum(r[4] for r in boxed), sum(r[5] for r in boxed)))
    # attack targets while allied-count high: distinct non-allied human/nation targets within minute
    # breaks
    br = [e for e in ev if e['type']=='breakAlliance']
    P('   breakAlliance %d: %s' % (len(br), [(mmss(e['t']), e['other']['name'][:12], 'victim %.2fx tiles' % (e['other']['tiles']/max(1,e['tiles']))) for e in br]))
    # attacks per sample with allies>=5 -> share of samples with outAtk>0
    s5 = [s for s in sm if s['t']>=60 and len(s['allies'])>=5]
    P('   samples with >=5 allies: %d; with outgoing attack %.0f%%; mean troops%% %.0f' % (len(s5), 100*len([s for s in s5 if s['outAtk']>0])/max(1,len(s5)), 100*st.mean([s['troops']/s['maxTroops'] for s in s5]) if s5 else 0))
    P('')
