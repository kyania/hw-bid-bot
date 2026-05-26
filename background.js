// background.js — service worker
// Resets session bid count whenever the extension starts up

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['stats'], ({ stats = {} }) => {
    stats.sessionBids = 0;
    chrome.storage.local.set({ stats });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    botActive:      false,
    bidHistory:     {},
    stats:          { totalBids: 0, sessionBids: 0 },
    userPrefs:      { subjects: [], messages: [], refreshIntervalSeconds: 8 },
    currentProject: null,
    currentIndex:   0,
    botStatusText:  { text: 'Idle — click Start Bot to begin', type: 'idle' },
  });
});
