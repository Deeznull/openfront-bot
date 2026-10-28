// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/sos-defense.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Unchanged. emojiId and enqueueSignal are shims in 00-shims.js (upstream's
// auto-bot emoji table and signal-scheduler.js are not ported).

// TN2 — When the local player is under attack, send an SOS emoji to allies /
// teammates and mark each attacker via SendTargetPlayerIntentEvent (rallies allies
// in their HUD; costs -40 relation with the attacker, acceptable since it is
// already attacking us). Standalone module — runs whether or not the auto-bot is
// on. All sends go through the shared signal scheduler (rate-limit-safe).

  const SOS_EMOJI = "🆘";
  const SOS_RESEND_MS = 12000; // resend the SOS salvo at most this often while attacked
  const SOS_TARGET_RESEND_MS = 16000; // re-mark the same attacker at most this often (> game 15s target cooldown)

  let sosDefenseEnabled = false;
  let _sosLastSalvoAt = 0;
  const _sosLastTargetAt = new Map(); // attacker smallID -> ms

  function _sosResolvePlayerBySmallId(game, smallId) {
    const players = getCachedPlayerViews(game);
    for (const p of players) {
      if (getPlayerSmallId(p, Number.NaN) === smallId) return p;
    }
    return null;
  }

  function _sosGetHostileAttackers(game, me) {
    const out = [];
    let attacks = [];
    try {
      attacks = me.incomingAttacks?.() || [];
    } catch (_e) {
      attacks = [];
    }
    for (const atk of attacks) {
      // Client AttackUpdate is a plain object: { troops, attackerID, targetID, ... }.
      const attackerId = Number(atk?.attackerID);
      if (!Number.isFinite(attackerId)) continue;
      const attacker = _sosResolvePlayerBySmallId(game, attackerId);
      if (!attacker) continue;
      try {
        if (me.isFriendly?.(attacker)) continue; // ignore allied "attacks"
      } catch (_e) {
        /* treat as hostile */
      }
      out.push(attacker);
    }
    return out;
  }

  function _sosGetAllies(game, me) {
    const players = getCachedPlayerViews(game);
    const allies = [];
    const mySid = getPlayerSmallId(me, Number.NaN);
    for (const p of players) {
      const sid = getPlayerSmallId(p, Number.NaN);
      if (!Number.isFinite(sid) || sid === mySid) continue;
      if (!p?.isAlive?.()) continue;
      if (isNationBotPlayer(p)) continue; // a nation bot won't come to help
      try {
        if (me.isFriendly?.(p)) allies.push(p);
      } catch (_e) {
        /* skip */
      }
    }
    return allies;
  }

  function updateSosDefense() {
    if (!sosDefenseEnabled) return;
    const context = getOpenFrontGameContext();
    const game = context?.game || null;
    if (!game) return;
    const me = game.myPlayer?.();
    if (!me || !me.isAlive?.()) return;

    const hostiles = _sosGetHostileAttackers(game, me);
    if (hostiles.length === 0) return;

    const nowMs = performance.now();
    const sosEmojiNum = emojiId(SOS_EMOJI);

    // 1) SOS to allies/teammates — one salvo per SOS_RESEND_MS.
    if (nowMs - _sosLastSalvoAt >= SOS_RESEND_MS) {
      _sosLastSalvoAt = nowMs;
      for (const ally of _sosGetAllies(game, me)) {
        enqueueSignal("emoji", ally, [ally, sosEmojiNum]);
      }
    }

    // 2) Mark each hostile attacker — throttled per-target.
    for (const attacker of hostiles) {
      const sid = getPlayerSmallId(attacker, Number.NaN);
      if (!Number.isFinite(sid)) continue;
      const last = _sosLastTargetAt.get(sid);
      if (last !== undefined && nowMs - last < SOS_TARGET_RESEND_MS) continue;
      _sosLastTargetAt.set(sid, nowMs);
      let targetId;
      try {
        targetId = attacker.id?.();
      } catch (_e) {
        targetId = undefined;
      }
      if (targetId !== undefined) enqueueSignal("target", attacker, [targetId]);
    }
  }

  function setSosDefenseEnabled(enabled) {
    sosDefenseEnabled = Boolean(enabled);
    if (!sosDefenseEnabled) {
      unregisterHelperTickListener(updateSosDefense);
      _sosLastSalvoAt = 0;
      _sosLastTargetAt.clear();
      return;
    }
    registerHelperTickListener(updateSosDefense);
  }
