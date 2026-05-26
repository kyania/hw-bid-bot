// popup.js

const toggleBtn          = document.getElementById('toggleBtn');
const refreshBtn         = document.getElementById('refreshBtn');
const statusBadge        = document.getElementById('statusBadge');
const botStatus          = document.getElementById('botStatus');
const sessionBids        = document.getElementById('sessionBids');
const totalBids          = document.getElementById('totalBids');
const saveBtn            = document.getElementById('saveBtn');
const saveStatus         = document.getElementById('saveStatus');
const fieldsInput        = document.getElementById('fieldsInput');
const msg1Input          = document.getElementById('msg1');
const refreshIntervalInput = document.getElementById('refreshIntervalInput');

// ── Load saved state on open ──────────────────────────────────────────────────
chrome.storage.local.get(['botActive', 'userPrefs', 'stats', 'botStatusText'], (data) => {
  setBotUI(data.botActive || false);

  if (data.userPrefs) {
    const prefs = data.userPrefs;
    fieldsInput.value = (prefs.subjects || []).join(', ');
    if (msg1Input) msg1Input.value = (prefs.messages || [])[0] || '';
    if (refreshIntervalInput) refreshIntervalInput.value = prefs.refreshIntervalSeconds || 8;
  }

  const stats = data.stats || {};
  sessionBids.textContent = stats.sessionBids || 0;
  totalBids.textContent   = stats.totalBids   || 0;

  if (data.botStatusText) setStatusText(data.botStatusText.text, data.botStatusText.type);
});

// ── Auto-save after 1.5 s of inactivity ──────────────────────────────────────
let autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => doSave(false), 1500);
}

[fieldsInput, msg1Input, refreshIntervalInput].forEach(el => {
  if (el) el.addEventListener('input', scheduleAutoSave);
});

// ── Poll stats every second while popup is open ───────────────────────────────
const pollInterval = setInterval(() => {
  chrome.storage.local.get(['stats', 'botStatusText', 'botActive'], (data) => {
    const stats = data.stats || {};
    sessionBids.textContent = stats.sessionBids || 0;
    totalBids.textContent   = stats.totalBids   || 0;
    if (data.botStatusText) setStatusText(data.botStatusText.text, data.botStatusText.type);
    setBotUI(data.botActive || false);
  });
}, 1000);

window.addEventListener('unload', () => clearInterval(pollInterval));

// ── Inspect current page ──────────────────────────────────────────────────────
document.getElementById('inspectBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'INSPECT' }, () => {
      if (chrome.runtime.lastError) {
        alert('Could not reach the page.\nMake sure you are on homeworkforyou.com and reload the tab.');
      }
    });
  });
});

// ── Toggle bot ────────────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  chrome.storage.local.get(['botActive', 'stats'], (data) => {
    const nowActive = !data.botActive;
    const stats     = data.stats || {};
    if (nowActive) stats.sessionBids = 0;

    chrome.storage.local.set({ botActive: nowActive, stats }, () => {
      setBotUI(nowActive);

      if (nowActive) {
        setStatusText('Bot started — going to browse page…', 'running');
        const BROWSE = 'https://www.homeworkforyou.com/project/browse/';
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (!tabs[0]) return;
          if (tabs[0].url && tabs[0].url.includes('homeworkforyou.com/project/browse/')) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'START' }).catch(() => {});
          } else {
            chrome.tabs.update(tabs[0].id, { url: BROWSE });
          }
        });
      } else {
        setStatusText('Bot stopped', 'idle');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'STOP' }).catch(() => {});
        });
      }
    });
  });
});

// ── Restart Scan button ───────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => {
  chrome.storage.local.get(['botActive'], (data) => {
    if (!data.botActive) {
      flash('⚠ Start the bot first before restarting the scan.', '#ff3d00');
      return;
    }

    // Reset index so it starts from the top of the list
    chrome.storage.local.set({ currentIndex: 0 }, () => {
      setStatusText('Restarting scan from top…', 'running');

      const BROWSE = 'https://www.homeworkforyou.com/project/browse/';
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        if (tabs[0].url && tabs[0].url.includes('homeworkforyou.com/project/browse/')) {
          // Already on browse page — send RESTART so content script re-runs immediately
          chrome.tabs.sendMessage(tabs[0].id, { action: 'RESTART' }).catch(() => {});
        } else {
          // Navigate to browse page; content script will auto-start on load
          chrome.tabs.update(tabs[0].id, { url: BROWSE });
        }
      });
    });
  });
});

// ── Save settings ─────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => doSave(true));

function doSave(showFeedback = false) {
  const msg1 = msg1Input?.value.trim() || '';
  if (!msg1) {
    if (showFeedback) flash('⚠ Bid message is required.', '#ff3d00');
    return;
  }

  const subjects = fieldsInput.value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const refreshIntervalSeconds = Math.max(1, parseInt(refreshIntervalInput?.value) || 8);

  chrome.storage.local.set({
    userPrefs: {
      subjects,
      messages: [msg1],
      refreshIntervalSeconds,
    }
  }, () => {
    if (showFeedback) flash('✓ Settings saved!', '#00c853');
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setBotUI(active) {
  toggleBtn.textContent   = active ? '■ Stop Bot' : '▶ Start Bot';
  toggleBtn.className     = `btn-toggle ${active ? 'stop' : 'start'}`;
  statusBadge.textContent = active ? 'ON' : 'OFF';
  statusBadge.classList.toggle('on', active);
}

function setStatusText(text, type = 'idle') {
  botStatus.textContent = text;
  botStatus.className   = `bot-status ${type}`;
}

function flash(msg, color) {
  saveStatus.style.color = color;
  saveStatus.textContent = msg;
  setTimeout(() => (saveStatus.textContent = ''), 3000);
}
