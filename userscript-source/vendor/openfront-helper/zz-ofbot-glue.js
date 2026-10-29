// ofbot glue for the vendored openfront-helper modules (not upstream code).
// Concatenated LAST into the same block as the vendored files, so it can reach
// their block-scoped state. Nothing here runs at load except publishing
// window.__ofbotHelper; every listener, interval and layer starts from set(true)
// and set(false) removes the feature's DOM, listeners and layers again.

function _ofbotHelperSafe(label, fn) {
  try {
    fn();
  } catch (error) {
    console.warn("[ofbot] helper feature " + label + " failed", error);
  }
}

function _ofbotRemoveById(ids) {
  for (const id of ids) {
    document.getElementById(id)?.remove();
  }
}

let _ofbotRatioKeysBound = false;

// "Boat target marks" drives the boat overlay (the old "Boat + warship
// routes" toggle and the warship routes were removed in 0.7.2.2).
function _ofbotSetBoatMarks(on) {
  boatBoldTrails = on;
  setBoatPredictionEnabled(on, {
    alwaysOwnRoutes: on,
    alwaysTeamRoutes: on,
    alwaysEnemyRoutes: on,
  });
}

let _ofbotAutoDonateTimer = null;

function _ofbotSetAutoDonate(on) {
  if (on) {
    _ofbotLoadHelperSettings();
    _quickPanelSettingsCache.autoDonateEnabled = true;
    _quickPanelSettingsCache.autoDonateGoldEnabled = true;
    if (_ofbotAutoDonateTimer === null) {
      _ofbotAutoDonateTimer = window.setInterval(() => window.__OFH_tickAutoDonate?.(), 1000);
    }
  } else {
    _quickPanelSettingsCache.autoDonateEnabled = false;
    _quickPanelSettingsCache.autoDonateGoldEnabled = false;
    if (_ofbotAutoDonateTimer !== null) {
      window.clearInterval(_ofbotAutoDonateTimer);
      _ofbotAutoDonateTimer = null;
    }
  }
}

window.__ofbotHelper = {
  // page.ts sets api to its play-aid intent sender (the bot's rate-limited
  // path); auto-donate and auto-defend send through it and nowhere else.
  api: null,
  features: [
    {
      key: "names",
      label: "Map troops/gold/threat",
      title: "Troop bar, gold and threat marks (nuke-capable, stronger, weak) above each player name.",
      set(on) {
        _ofbotHelperSafe("names", () => {
          setPlayerMapOverlaysEnabled(true);
          setMapTroopCountsEnabled(on);
          setThreatIndicatorsEnabled(on);
          setMapMoneyEnabled(on);
          requestMapOverlayLoop();
        });
      },
    },
    {
      key: "attacks",
      label: "Attack highlight",
      title: "Rings each player attacking you, with a line to your land and the incoming troop total.",
      set(on) {
        _ofbotHelperSafe("attacks", () => {
          setAttackHighlightEnabled(on);
          requestMapOverlayLoop();
        });
      },
    },
    {
      key: "nukes",
      label: "Nuke landing + path",
      title: "Marks where nukes in flight will land, with their blast radius and flight path.",
      set(on) {
        _ofbotHelperSafe("nukes", () => {
          setNukePredictionEnabled(on);
          setNukeTrajectoryEnabled(on);
          requestMapOverlayLoop();
        });
      },
    },
    {
      key: "boatTrails",
      label: "Boat target marks",
      title: "Puts a target symbol on the tile where each of your, your team's and enemy transport boats will land: yours blue, allies and teammates green, others red (no route line; hover a mark to see the route).",
      set(on) {
        _ofbotHelperSafe("boatTrails", () => _ofbotSetBoatMarks(on));
      },
    },
    {
      key: "timers",
      label: "Build timers",
      title: "Construction countdowns and missile cooldowns above silos and SAM launchers.",
      set(on) {
        _ofbotHelperSafe("timers", () => {
          setBuildTimerEnabled(on);
          requestMapOverlayLoop();
        });
      },
    },
    {
      key: "teams",
      label: "Team build stats",
      title: "Panel with each team's structures, plus an alert when an enemy builds a missile silo.",
      set(on) {
        _ofbotHelperSafe("teams", () => {
          setTeamBuildStatsEnabled(on);
          if (!on) {
            _ofbotRemoveById([TEAM_BUILD_PANEL_ID, TEAM_BUILD_ALERT_CONTAINER_ID]);
          }
        });
      },
    },
    {
      key: "estates",
      label: "Estates panel",
      title: "Lists each separate piece of land you own; click a row to move the camera there.",
      set(on) {
        _ofbotHelperSafe("estates", () => {
          setEstatePanelEnabled(on);
          if (!on) {
            _ofbotRemoveById([ESTATE_PANEL_ID]);
          }
        });
      },
    },
    {
      key: "timeAlert",
      label: "5-minute time alert",
      title: "One notice when the match reaches 5 minutes.",
      set(on) {
        _ofbotHelperSafe("timeAlert", () => setGameTimeAlertEnabled(on, 300));
      },
    },
    {
      key: "ratioKeys",
      label: "Shift+1..0 attack ratio",
      title: "Shift+1 to Shift+0 set the attack-ratio slider to 10% to 100%.",
      set(on) {
        _ofbotHelperSafe("ratioKeys", () => {
          setAttackRatioHotkeyEnabled(on);
          if (on && !_ofbotRatioKeysBound) {
            window.addEventListener("keydown", handleAttackRatioHotkey, true);
            _ofbotRatioKeysBound = true;
          } else if (!on && _ofbotRatioKeysBound) {
            window.removeEventListener("keydown", handleAttackRatioHotkey, true);
            _ofbotRatioKeysBound = false;
          }
        });
      },
    },
    {
      key: "allies",
      label: "Ally markers",
      title: "Marks your allies on the map with the time left on each alliance.",
      set(on) {
        _ofbotHelperSafe("allies", () => setAllyMarkersEnabled(on));
      },
    },
    {
      key: "bots",
      label: "Bot nation markers",
      title: "Marks nation-AI (bot) players on the map: red dot, green for allies and teammates.",
      set(on) {
        _ofbotHelperSafe("bots", () => setBotMarkersEnabled(on));
      },
    },
    {
      key: "antiAfk",
      label: "Anti-AFK keep-alive",
      title:
        "While the tab is hidden, re-runs the game's own ping if it stalls for 12 s, so the server doesn't mark you disconnected. Switch on before the match starts.",
      set(on) {
        _ofbotHelperSafe("antiAfk", () => setAntiAfkEnabled(on));
      },
    },
    {
      key: "autoDonate",
      label: "Auto-donate troops/gold",
      title:
        "Troops: above 40% of your max, sends 25% to the weakest friendly player in a fight. Gold: above 5M, sends 25% to the poorest friendly player. At most once per 3 s each.",
      set(on) {
        _ofbotHelperSafe("autoDonate", () => _ofbotSetAutoDonate(on));
      },
    },
    {
      key: "sos",
      label: "Auto-defend (SOS)",
      title:
        "When someone attacks you: an SOS emoji to your allies/teammates (every 12 s) and a target mark on each attacker (every 16 s per attacker).",
      set(on) {
        _ofbotHelperSafe("sos", () => setSosDefenseEnabled(on));
      },
    },
    {
      key: "autoLeave",
      label: "Auto-leave after a win",
      title: "When the end screen says you (or your team) won, goes back to the home page.",
      set(on) {
        _ofbotHelperSafe("autoLeave", () => setAutoLeaveOnTeamWinEnabled(on));
      },
    },
  ],
};
