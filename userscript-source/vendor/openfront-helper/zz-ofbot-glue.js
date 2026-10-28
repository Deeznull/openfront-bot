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

function _ofbotTeardownGoldPerMinute() {
  _ofbotRemoveById([TOP_GOLD_PER_MINUTE_BADGE_ID, HELPER_STATS_CONTAINER_ID]);
  apsRenderedExpanded = null;
  apsRowCache.clear();
  apsHeaderCells = null;
  apsFooterEntry = null;
  if (_helperStatsLayoutListenersBound) {
    window.removeEventListener("resize", markHelperStatsLayoutDirty);
    const visualViewport = window.visualViewport;
    if (visualViewport) {
      visualViewport.removeEventListener("resize", markHelperStatsLayoutDirty);
      visualViewport.removeEventListener("scroll", markHelperStatsLayoutDirty);
    }
    _helperStatsResizeObserver?.disconnect();
    _helperStatsResizeObserver = null;
    _helperStatsLayoutListenersBound = false;
  }
}

window.__ofbotHelper = {
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
      key: "boats",
      label: "Boat + warship routes",
      title: "Draws transport-boat and warship routes, plus a panel listing boats sent and incoming.",
      set(on) {
        _ofbotHelperSafe("boats", () => {
          setBoatPredictionEnabled(on);
          setBoatPanelEnabled(on);
          setWarshipRoutesEnabled(on);
          if (!on) {
            _ofbotRemoveById([BOAT_PANEL_ID]);
          }
        });
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
      key: "gpm",
      label: "Players / gold-per-min",
      title: "All-players table with gold per minute and stats. Hides the game's own leaderboard while on.",
      set(on) {
        _ofbotHelperSafe("gpm", () => {
          // Off in this order: the sampler only stops once the panel is off too.
          if (on) {
            setGoldPerMinuteEnabled(true);
            setTopGoldPerMinuteEnabled(true);
          } else {
            setTopGoldPerMinuteEnabled(false);
            setGoldPerMinuteEnabled(false);
            _ofbotTeardownGoldPerMinute();
          }
        });
      },
    },
    {
      key: "advisor",
      label: "Advisor panel",
      title: "Panel with your troop economy, safe-to-spend troops and the biggest enemy threats.",
      set(on) {
        _ofbotHelperSafe("advisor", () => setAdvisorPanelEnabled(on));
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
      key: "retal",
      label: "Nuke-incoming alert",
      title: "Card when an enemy nuke targets you, with a button that moves the camera to it.",
      set(on) {
        _ofbotHelperSafe("retal", () => setRetaliationEnabled(on));
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
      title: "Marks nation-AI (bot) players on the map.",
      set(on) {
        _ofbotHelperSafe("bots", () => setBotMarkersEnabled(on));
      },
    },
  ],
};
