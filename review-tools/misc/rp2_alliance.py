"""RP2: alliance lifecycle per game: extension timing, expiry strikes, expiry stagger.
usage: python tools/rp2_alliance.py"""
import json, os, collections, statistics as st
R = os.path.join(os.path.dirname(__file__), 'replays', 'state2')
G = 'cboH5FnC2C cP7ZSWJmaB cwC2ePQW5r cpSnhwx1gW cAbJjEnvfF cFvb4MzK2V ctaYosHkfS cdn6SnPDLm ckBpXCXJHC cDdxe79See cFzeBcD9SD cPWYjmAWDE'.split()
def mmss(t): return '%d:%02d' % (int(t)//60, int(t)%60)
tot = collections.Counter()
for g in G:
    d = json.load(open(os.path.join(R, g+'.state.json'))); ev = d['events']; me = d['meta']['me']
    ends = [e for e in ev if e['type']=='ALLY_ENDED' and e['how']=='expired' and e['other']['type']=='human']
    ext = [e for e in ev if e['type']=='allianceExtension']
    formed = {}
    for e in ev:
        if e['type']=='ALLIED': formed.setdefault(e['other']['id'], []).append(e['t'])
    # extension lead time: seconds before the current alliance's expiry (formed+300, or previous ext+300)
    lead = []
    for e in ext:
        oid = e['other']['id']; fs = [t for t in formed.get(oid, []) if t <= e['t']]
        if fs: lead.append(300 - (e['t'] - max(fs)))
    # (extensions reset timer so this is only a first-extension estimate)
    atk = collections.defaultdict(list)
    for e in ev:
        if e['type']=='attack' and e['target']['type']=='human': atk[e['target']['id']].append(e)
    strikes = []
    for e in ends:
        oid = e['other']['id']
        a = [x for x in atk.get(oid, []) if e['t']-3 <= x['t'] <= e['t']+120]
        if a: strikes.append((mmss(e['t']), e['other']['name'][:14], len(a), round(a[0]['t']-e['t']), 'x%.2f' % (e['other']['tiles']/max(1, a[0]['tiles']))))
    # stagger: expiries per 30 s bucket
    b = collections.Counter(int(e['t']//30) for e in ends)
    same = sum(1 for v in b.values() if v >= 2)
    allexp = [e for e in ev if e['type']=='ALLY_ENDED' and e['how']=='expired']
    tot['games'] += 1; tot['expired_h'] += len(ends); tot['strike'] += len(strikes); tot['ext'] += len(ext)
    print('%s %s: expired(human) %d, extensions %d (lead s median %s), ex-ally attacked within 120s: %d %s | 30s buckets with >=2 expiries: %d of %d' % (
        g, me, len(ends), len(ext), round(st.median(lead)) if lead else None, len(strikes), strikes[:5], same, len(b)))
print(dict(tot))
