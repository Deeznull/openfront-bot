// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/attack-ratio-hotkey.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Trimmed: nothing (verbatim copy)

// Attack-ratio hotkey: Shift+1..0 sets the game's attack-ratio slider to
// 10%..100%. The slider lives in the game's build-menu / control-panel shadow
// DOM; we find it by probing for an input[type=range] whose value controls the
// attack troop fraction. If the slider cannot be found the feature silently
// does nothing — it never blocks other hotkeys.

  const ATTACK_RATIO_HOTKEY_BINDINGS = {
    Digit1: 10, Digit2: 20, Digit3: 30, Digit4: 40, Digit5: 50,
    Digit6: 60, Digit7: 70, Digit8: 80, Digit9: 90, Digit0: 100,
  };

  // Cached reference to the game's attack-ratio <input type="range">.
  let _attackRatioSlider = null;
  let _attackRatioSliderSearchedAt = 0;
  const ATTACK_RATIO_SLIDER_RESCAN_MS = 4000;

  function findAttackRatioSlider() {
    const now = performance.now();
    if (_attackRatioSlider && _attackRatioSlider.isConnected) {
      return _attackRatioSlider;
    }
    if (now - _attackRatioSliderSearchedAt < ATTACK_RATIO_SLIDER_RESCAN_MS) {
      return null;
    }
    _attackRatioSliderSearchedAt = now;
    // Probe known game containers for a range input whose label or tooltip
    // contains "attack" or the attack-ratio icon.
    const candidates = document.querySelectorAll(
      'input[type="range"], [role="slider"]',
    );
    for (const el of candidates) {
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.closest("label")?.textContent ||
        ""
      ).toLowerCase();
      if (
        label.includes("attack") ||
        label.includes("ratio") ||
        label.includes("angriff")
      ) {
        _attackRatioSlider = el;
        return el;
      }
    }
    return null;
  }

  function setAttackRatioSlider(percent) {
    const slider = findAttackRatioSlider();
    if (!slider) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    // Use the native setter to bypass React/framework wrappers.
    const nativeSetter =
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set ||
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
    if (nativeSetter) {
      nativeSetter.call(slider, value);
    } else {
      slider.value = value;
    }
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function handleAttackRatioHotkey(event) {
    if (!attackRatioHotkeyEnabled) return;
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const percent = ATTACK_RATIO_HOTKEY_BINDINGS[event.code];
    if (percent === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setAttackRatioSlider(percent);
  }

  function setAttackRatioHotkeyEnabled(enabled) {
    attackRatioHotkeyEnabled = Boolean(enabled);
    if (!attackRatioHotkeyEnabled) {
      _attackRatioSlider = null;
    }
  }
