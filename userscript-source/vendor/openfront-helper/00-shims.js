// ofbot shims for the vendored openfront-helper modules (not upstream code).
// tr(): upstream i18n lookup replaced by an English pass-through with {name}
// placeholder substitution. getTradeEventGoldAmount(): copied from upstream
// engine/ingame/trade-balances.js (that module itself is not ported), used by
// gold-per-minute.js.
function tr(k,p){let s=k;if(p)for(const n in p)s=s.split("{"+n+"}").join(String(p[n]));return s;}

function getTradeEventGoldAmount(value) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value);
}
