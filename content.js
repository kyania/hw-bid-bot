// content.js

const BROWSE_URL = 'https://www.homeworkforyou.com/project/browse/';
const IS_BROWSE  = window.location.pathname === '/project/browse/';
const IS_PROJECT = /^\/project\/\d+/.test(window.location.pathname);

let stopped = false;

// ── Listen for START / STOP / RESTART / INSPECT from popup ───────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'STOP')                 { stopped = true; }
  if (msg.action === 'START'   && IS_BROWSE) { stopped = false; runBrowsePage(); }
  if (msg.action === 'RESTART' && IS_BROWSE) { stopped = false; runBrowsePage(); }
  if (msg.action === 'INSPECT')              { runInspect(); sendResponse({ ok: true }); }
});

// ── Auto-run on page load if bot is active ────────────────────────────────────
chrome.storage.local.get(['botActive'], ({ botActive }) => {
  if (!botActive) return;
  if (IS_BROWSE)  runBrowsePage();
  if (IS_PROJECT) runProjectPage();
});

// ═════════════════════════════════════════════════════════════════════════════
// BROWSE PAGE
// Real rows: <div class="row r-d-inner r-d-shadow ...">
//   .col-sm-6 .r-small-data → title/link
//   .col-sm-2 .r-small-data (first) → price
//   .col-sm-1 last-child a.btn-warning → "Bid" link
// ═════════════════════════════════════════════════════════════════════════════
async function runBrowsePage() {
  if (stopped) return;
  setStatus('Scanning browse page…', 'running');

  // Wait for AngularJS to render the project grid
  await waitFor('.r-d-inner', 5000).catch(() => null);

  // ── Scrape project rows ───────────────────────────────────────────────────
  const projects = [];
  const rows = Array.from(document.querySelectorAll('.r-d-inner'))
    .filter(row => row.querySelector('a[href*="/project/"]'));

  for (const row of rows) {
    const link = row.querySelector('a[href*="/project/"]');
    if (!link) continue;

    const href    = link.getAttribute('href') || '';
    const idMatch = href.match(/\/project\/(\d+)\//);
    if (!idMatch) continue;

    const col2s   = row.querySelectorAll('.col-sm-2 .r-small-data');
    const titleEl = row.querySelector('.col-sm-6 .r-small-data');

    projects.push({
      id:    idMatch[1],
      title: titleEl?.textContent.trim() || link.textContent.trim(),
      price: parseFloat((col2s[0]?.textContent || '').replace(/[^0-9.]/g, '')) || 0,
      href,
    });
  }

  const { userPrefs = {} } = await getStorage(['userPrefs']);
  const refreshMs = Math.max(1, (userPrefs.refreshIntervalSeconds || 8)) * 1000;

  if (!projects.length) {
    setStatus('No projects found — refreshing…', 'idle');
    await sleep(refreshMs);
    if (!stopped) location.reload();
    return;
  }

  const { currentIndex = 0, bidHistory = {} } =
    await getStorage(['currentIndex', 'bidHistory']);

  // ── Walk from currentIndex, find the next un-bid project ─────────────────
  const startPos    = currentIndex % projects.length;
  let   actionTaken = false;

  for (let i = 0; i < projects.length; i++) {
    const pos    = (startPos + i) % projects.length;
    const p      = projects[pos];
    const record = bidHistory[p.id];   // undefined | 'skipped' | 'form_error' | object

    // Not yet bid (or previous form error worth retrying)
    if (!record || record === 'form_error') {
      await goTo(p, pos, projects.length);
      actionTaken = true;
      break;
    }
    // Already bid (object) or skipped → keep walking
  }

  if (!actionTaken) {
    // All projects have been bid — reset and wait before next cycle
    const secs = userPrefs.refreshIntervalSeconds || 8;
    setStatus(`All ${projects.length} checked. Refreshing in ${secs}s…`, 'done');
    await setStorage({ currentIndex: 0 });
    await sleep(refreshMs);
    if (!stopped) location.reload();
  }
}

// Store state and navigate to the project bid page
async function goTo(project, idx, total) {
  setStatus(
    `[${idx + 1}/${total}] Opening: "${truncate(project.title, 40)}"`,
    'bidding'
  );
  await setStorage({
    currentProject: project,
    currentIndex:   idx + 1,
    currentAction:  'bid',
  });
  if (!stopped) window.location.href = project.href;
}

// ═════════════════════════════════════════════════════════════════════════════
// PROJECT PAGE
// ═════════════════════════════════════════════════════════════════════════════
async function runProjectPage() {
  if (stopped) return;

  const { currentProject: project, currentAction: action,
          userPrefs = {}, bidHistory = {}, stats = {} } =
    await getStorage(['currentProject','currentAction','userPrefs','bidHistory','stats']);

  if (!project) { window.location.href = BROWSE_URL; return; }

  if (action === 'bid') {
    await doInitialBid(project, userPrefs, bidHistory, stats);
  } else {
    // Any other action (stale data) — just go back to browse
    window.location.href = BROWSE_URL;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIAL BID
// If already bid:   detect "Bid Message you sent:", record it, go back
// If subject mismatch: mark skipped, go back
// If fresh bid page:  fill amount + message, submit, record, go back
// ─────────────────────────────────────────────────────────────────────────────
async function doInitialBid(project, userPrefs, bidHistory, stats) {
  setStatus(`Bidding: "${truncate(project.title, 40)}"`, 'bidding');

  // AngularJS render pause
  await sleep(400);

  // ── Already bid? ──────────────────────────────────────────────────────────
  // Real page indicator: <b>Bid Message you sent:</b>
  if (alreadyBidOnPage()) {
    setStatus('Already bid — returning to browse', 'running');
    if (!bidHistory[project.id] || typeof bidHistory[project.id] !== 'object') {
      bidHistory[project.id] = { bidAt: Date.now(), amount: project.price };
    }
    await setStorage({ bidHistory });
    window.location.href = BROWSE_URL;
    return;
  }

  // ── Subject filter ────────────────────────────────────────────────────────
  const fields = userPrefs.subjects || [];
  if (fields.length > 0 && !categoryMatchesPage(fields)) {
    setStatus('Skipped — subject not in your list', 'running');
    bidHistory[project.id] = 'skipped';
    await setStorage({ bidHistory });
    window.location.href = BROWSE_URL;
    return;
  }

  // ── Find the initial bid form (NOT the change-bid form) ───────────────────
  const bidForm = await waitForBidForm(4000);
  if (!bidForm) {
    setStatus('⚠ Bid form not found — skipping', 'error');
    bidHistory[project.id] = 'form_error';
    await setStorage({ bidHistory });
    window.location.href = BROWSE_URL;
    return;
  }

  const { form, amountInput, msgTextarea } = bidForm;

  // Scroll into view so the user can see the bot working
  amountInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(150);

  // Fill the client's posted price
  setNativeValue(amountInput, String(project.price));

  // Fill the bid message (messages[0] = msg1)
  if (msgTextarea) {
    setNativeValue(msgTextarea, (userPrefs.messages || [])[0] || '');
    msgTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(100);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  const submitBtn = findSubmitButton(form);
  if (!submitBtn) {
    setStatus('⚠ Submit button not found — skipping', 'error');
    bidHistory[project.id] = 'form_error';
    await setStorage({ bidHistory });
    window.location.href = BROWSE_URL;
    return;
  }

  submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(100);
  submitBtn.click();

  // ── Record ────────────────────────────────────────────────────────────────
  bidHistory[project.id] = { bidAt: Date.now(), amount: project.price };
  stats.totalBids   = (stats.totalBids   || 0) + 1;
  stats.sessionBids = (stats.sessionBids || 0) + 1;
  await setStorage({ bidHistory, stats });

  setStatus(`✅ Bid placed $${project.price} — "${truncate(project.title, 35)}"`, 'running');
  await sleep(400);
  if (!stopped) window.location.href = BROWSE_URL;
}

// ═════════════════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Check category text visible on the project page: <b>Category:</b> Mathematics
function categoryMatchesPage(selectedFields) {
  const text = document.body.innerText.toLowerCase();
  return selectedFields.some(f => text.includes(f.toLowerCase()));
}

// Page shows <b>Bid Message you sent:</b> when the user has already bid
function alreadyBidOnPage() {
  return document.body.innerText.includes('Bid Message you sent:');
}

// Poll for the initial bid form to appear (AngularJS may be slow)
async function waitForBidForm(timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = findInitialBidForm();
    if (result) return result;
    await sleep(100);
  }
  return null;
}

// Find the bid submission form — skip the "Change Bid" form (action "/change/")
function findInitialBidForm() {
  for (const form of document.querySelectorAll('form')) {
    const action = (form.getAttribute('action') || '').toLowerCase();
    if (action.includes('/change/')) continue;

    const amountInput = form.querySelector(
      'input[name="amount"], input[name="bid_amount"], input[name="price"], input[type="number"]'
    );
    if (!amountInput) continue;

    const msgTextarea = form.querySelector('textarea');
    return { form, amountInput, msgTextarea };
  }
  return null;
}

// Find the submit/place-bid button inside the form
function findSubmitButton(form) {
  if (form) {
    for (const btn of form.querySelectorAll('button, input[type="submit"]')) {
      const label = (btn.textContent || btn.value || '').toLowerCase();
      if (label.includes('bid') || label.includes('place') || label.includes('submit')) return btn;
    }
    const anyBtn = form.querySelector('button[type="submit"], input[type="submit"], button');
    if (anyBtn) return anyBtn;
  }
  for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
    const label = (btn.textContent || btn.value || '').toLowerCase();
    if (label.includes('bid') || label.includes('place') || label.includes('submit')) return btn;
  }
  return null;
}

// Trigger Angular/React ng-model update — plain el.value = x bypasses $watch
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Wait for a CSS selector to appear (MutationObserver-based)
function waitFor(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error(`timeout: ${selector}`)); }, timeout);
  });
}

const getStorage = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
const setStorage = (data) => new Promise(r => chrome.storage.local.set(data, r));
const sleep      = (ms)   => new Promise(r => setTimeout(r, ms));
const truncate   = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;
const setStatus  = (text, type = 'idle') => setStorage({ botStatusText: { text, type } });

// ═════════════════════════════════════════════════════════════════════════════
// INSPECT — debug overlay
// ═════════════════════════════════════════════════════════════════════════════
function runInspect() {
  document.getElementById('__hwbot_overlay__')?.remove();

  const lines = [];
  const path  = window.location.pathname;

  // ── BROWSE PAGE ────────────────────────────────────────────────────────────
  if (path === '/project/browse/') {
    lines.push('PAGE TYPE: Browse page\n');

    const rows = Array.from(document.querySelectorAll('.r-d-inner'))
      .filter(r => r.querySelector('a[href*="/project/"]'));

    if (!rows.length) {
      lines.push('❌  No .r-d-inner project rows found.');
      for (const sel of ['.row', 'tr', '.card', '[class*="inner"]', '[class*="r-d"]']) {
        const cnt = document.querySelectorAll(sel).length;
        if (cnt) lines.push(`    "${sel}": ${cnt} elements`);
      }
    } else {
      lines.push(`✅  Found ${rows.length} project rows\n`);
      let n = 0;
      for (const row of rows) {
        if (n++ >= 4) { lines.push(`  … and ${rows.length - 4} more`); break; }
        const link  = row.querySelector('a[href*="/project/"]');
        const title = row.querySelector('.col-sm-6 .r-small-data')?.textContent.trim() || '?';
        const price = row.querySelectorAll('.col-sm-2 .r-small-data')[0]?.textContent.trim() || '?';
        const id    = link?.getAttribute('href')?.match(/\/project\/(\d+)\//)?.[1] || '?';
        lines.push(`  [${n}] ID:${id}  ${price}  "${truncate(title, 45)}"`);
      }
    }
  }

  // ── PROJECT / BID PAGE ─────────────────────────────────────────────────────
  else if (/^\/project\/\d+/.test(path)) {
    lines.push('PAGE TYPE: Project / Bid page\n');

    const already = alreadyBidOnPage();
    lines.push(already
      ? '✅  ALREADY BID — "Bid Message you sent:" found'
      : '⬜  Fresh bid page — no prior bid detected');

    lines.push(`ℹ️  Category: ${document.body.innerText.match(/Category:\s*([^\n]+)/)?.[1]?.trim() || '(not found)'}`);
    lines.push('');

    if (!already) {
      const bidForm = findInitialBidForm();
      if (bidForm) {
        lines.push('✅  Bid form found');
        lines.push(`    action="${bidForm.form.getAttribute('action')}"`);
        lines.push(`    amount input: name="${bidForm.amountInput.name}"  value="${bidForm.amountInput.value}"`);
        lines.push(bidForm.msgTextarea
          ? `    message textarea: name="${bidForm.msgTextarea.name}"`
          : '⚠️   No textarea in bid form');
        const btn = findSubmitButton(bidForm.form);
        lines.push(btn ? `✅  Submit btn: "${btn.textContent.trim()}"` : '❌  No submit button');
      } else {
        lines.push('❌  Bid form NOT found');
        document.querySelectorAll('form').forEach(f =>
          lines.push(`    form action="${f.getAttribute('action')}"  inputs:${f.querySelectorAll('input').length}  textareas:${f.querySelectorAll('textarea').length}`)
        );
      }
    }

    lines.push('');
    lines.push('All buttons:');
    document.querySelectorAll('button').forEach(b =>
      lines.push(`  "${b.textContent.trim().slice(0, 35)}"  type="${b.type}"`)
    );
  }

  else {
    lines.push(`PAGE TYPE: Unknown (${path})`);
    lines.push('Navigate to the browse page or a project page and Inspect again.');
  }

  // ── Overlay ────────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__hwbot_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: '999999',
    background: '#1a1a2e', color: '#e0e0e0',
    fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6',
    padding: '16px 18px', borderRadius: '10px',
    maxWidth: '540px', maxHeight: '82vh', overflowY: 'auto',
    boxShadow: '0 4px 24px rgba(0,0,0,0.5)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  });

  const hdr = document.createElement('div');
  hdr.textContent = '🔍 HW Bot Inspector';
  Object.assign(hdr.style, { fontWeight: 'bold', fontSize: '13px', marginBottom: '10px', color: '#00c853' });
  overlay.appendChild(hdr);

  const bd = document.createElement('div');
  bd.textContent = lines.join('\n');
  overlay.appendChild(bd);

  const cls = document.createElement('button');
  cls.textContent = '✕ Close';
  Object.assign(cls.style, {
    display: 'block', marginTop: '12px', padding: '5px 14px',
    background: '#ff3d00', color: '#fff', border: 'none',
    borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
  });
  cls.onclick = () => overlay.remove();
  overlay.appendChild(cls);

  document.body.appendChild(overlay);
}
