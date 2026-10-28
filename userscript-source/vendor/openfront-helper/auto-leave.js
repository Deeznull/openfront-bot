// Vendored from openfront-helper (https://github.com/nguyenvancaokyfpt/openfront-helper-userscript)
// @ a4c6957, engine/ingame/auto-leave.js
// AGPL-3.0-or-later, (c) nguyenvancaokyfpt and contributors. See README.md here.
// Unchanged.

// Auto-leave on team win: when the game's win-modal shows that YOU / your team
// won, leave the match (navigate to home). Pairs with "keep searching" auto-join
// for continuous play. The win-modal exposes `isVisible` + `isWin` directly
// (it renders into light DOM, createRenderRoot returns this), and `isWin` is set
// true ONLY when the local player's team/self is the winner — not on a loss.

  let autoLeaveOnTeamWin = false;
  let autoLeaveTimer = null;
  let autoLeaveFired = false; // navigated already this page-load

  function checkAutoLeaveOnWin() {
    if (!autoLeaveOnTeamWin || autoLeaveFired) {
      return;
    }
    let modal = null;
    try {
      modal = document.querySelector("win-modal");
    } catch (_error) {
      return;
    }
    if (!modal) {
      return;
    }
    if (modal.isVisible === true && modal.isWin === true) {
      autoLeaveFired = true;
      try {
        // Exit to home; with "keep searching" auto-join on, the lobby page that
        // loads will resume searching for the next match.
        window.location.href = "/";
      } catch (_error) {
        // navigation is best-effort
      }
    }
  }

  function setAutoLeaveOnTeamWinEnabled(enabled) {
    autoLeaveOnTeamWin = Boolean(enabled);
    if (autoLeaveOnTeamWin) {
      if (autoLeaveTimer === null) {
        autoLeaveTimer = window.setInterval(checkAutoLeaveOnWin, 1000);
      }
    } else if (autoLeaveTimer !== null) {
      clearInterval(autoLeaveTimer);
      autoLeaveTimer = null;
    }
  }
