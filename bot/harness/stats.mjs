// Shared stats for Eval.mjs / Paired.mjs: per-game metrics and paired comparison.
// Per-game metrics (one number per game; the summary averages them).
export const majors = (r) => Math.max(1, (r.nations ?? 0) + (r.lobby?.players ?? 1));
export const METRICS = {
  phaseFit: (r) => (r.outcome === "dead" ? 0 : (r.finalShare ?? 0) * 10 + 1 - r.finalRank / majors(r)),
  fit: (r) => (r.outcome === "win" ? 1 : 0) + (r.finalShare ?? 0) + (r.outcome === "dead" ? 0 : 0.2),
  win: (r) => (r.outcome === "win" ? 1 : 0),
  alive: (r) => (r.outcome === "dead" ? 0 : 1),
  finalShare: (r) => r.finalShare ?? 0,
  share10: (r) => r.checkpoints?.["10m"]?.share ?? 0,
  rankFit: (r) => (r.outcome === "dead" ? 0 : 1 - r.finalRank / majors(r)),
  // Learned value proxy: P(win) from the 15-min state, logistic fit on 512 cached
  // full games (tests/bot/proxy_fit.py, CV AUC .91 over all games). Run with --maxMin 15.5.
  pwin15: (r) => {
    if (r.outcome === "win") return 1;
    const cp = r.checkpoints?.["15m"];
    if (r.outcome === "dead" || !cp) return 0;
    const s = Math.max(cp.share, 1e-4), L = Math.max(cp.L ?? s, 1e-4);
    const z = 0.5351 + 0.2247 * Math.log(s) + 0.6679 * Math.log(s / L) + 0.0386 * Math.log((r.lobby?.players ?? 50) / 50);
    return 1 / (1 + Math.exp(-z));
  },
};

// Deterministic PRNG for the bootstrap (reproducible CIs).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function pairedStats(d) {
  const n = d.length;
  if (n === 0) return null;
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const rnd = rng(12345);
  const boots = [];
  for (let b = 0; b < 4000; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rnd() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const lo = boots[Math.floor(0.025 * boots.length)];
  const hi = boots[Math.floor(0.975 * boots.length) - 1];
  const eps = 1e-9;
  const W = d.filter((x) => x > eps).length;
  const L = d.filter((x) => x < -eps).length;
  // Two-sided exact sign test on W vs L (ties dropped).
  const m = W + L;
  let p = 1;
  if (m > 0) {
    const k = Math.min(W, L);
    let c = 0;
    let binom = 1; // C(m,0)
    for (let i = 0; i <= k; i++) {
      c += binom;
      binom = (binom * (m - i)) / (i + 1);
    }
    p = Math.min(1, (2 * c) / 2 ** m);
  }
  return { n, mean: +mean.toFixed(3), lo: +lo.toFixed(3), hi: +hi.toFixed(3), W, L, T: n - m, p: +p.toFixed(3) };
}

