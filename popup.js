/****************************************************************
 * Text Only — popup / options page
 *
 * Pure view + editor over chrome.storage.sync; the background owns
 * rule application. All state changes land in storage and re-render
 * via storage.onChanged, exactly like simple-auto-hd's popup.
 ****************************************************************/

const DEFAULTS = {
  enabled: true,
  defaultMode: 'on',
  sites: [],
  blockVideo: true,
  theme: 'system',
};

const $ = id => document.getElementById(id);

const els = {
  enabledLabel: $('extension-status'),
  enabled: $('extension-enabled'),
  modeHint: $('mode-hint'),
  siteHost: $('site-host'),
  siteHint: $('site-hint'),
  siteToggle: $('site-toggle'),
  siteRow: $('site-toggle').closest('.row'),
  blockVideo: $('block-video'),
  listTitle: $('list-title'),
  siteInput: $('site-input'),
  siteAdd: $('site-add'),
  siteList: $('site-list'),
  siteEmpty: $('site-empty'),
  status: $('status'),
};

const statusText = els.status.querySelector('.status__text');
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const themeInputs = [...document.querySelectorAll('input[name="theme"]')];
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

let settings = { ...DEFAULTS };
/** Set when an edit affects already-open pages, cleared on re-render. */
let dirty = false;

// Mirrors background.js decide(); keep the two in sync.
function decide(s, host) {
  if (!s.enabled || !host) return false;
  const listed = s.sites.includes(host);
  return s.defaultMode === 'on' ? !listed : listed;
}

/** "https://www.Example.com/x" -> "example.com"; "" when not a host. */
function normalizeHost(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (!host) return '';
  if (!host.includes('://')) host = `https://${host}`;
  try {
    host = new URL(host).hostname;
  } catch {
    return '';
  }
  return host.replace(/^www\./, '');
}

function applyTheme(choice) {
  const resolved = choice === 'system' ? (prefersLight.matches ? 'light' : 'dark') : choice;
  document.documentElement.dataset.theme = resolved;
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  statusText.textContent = text;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** activeTab grants url access for the tab the popup was opened on. */
function hostOfTab(tab) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return '';
  return normalizeHost(tab.url);
}

// ———————————————————————————————————— rendering ————————————————————————————————————

function renderList() {
  const excluding = settings.defaultMode === 'on';
  $('mode-all').checked = excluding;
  $('mode-none').checked = !excluding;
  els.modeHint.textContent = excluding
    ? 'Text Only is on everywhere except the list below.'
    : 'Text Only is off everywhere except the list below.';
  els.listTitle.textContent = excluding ? 'Excluded sites' : 'Whitelisted sites';

  els.siteList.textContent = '';
  for (const host of settings.sites) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'site-host';
    name.textContent = host;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'site-remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Remove ${host}`);
    remove.addEventListener('click', () => {
      save({ sites: settings.sites.filter(x => x !== host) });
    });

    li.append(name, remove);
    els.siteList.append(li);
  }

  els.siteEmpty.textContent =
    settings.sites.length > 0
      ? ''
      : excluding
        ? 'No exclusions — Text Only is on for every site.'
        : 'Empty whitelist — Text Only is off for every site.';
}

function renderSiteRow(host) {
  if (!host) {
    els.siteRow.hidden = true;
    return;
  }
  els.siteRow.hidden = false;
  const listed = settings.sites.includes(host);
  els.siteHost.textContent = host;
  els.siteToggle.checked = decide(settings, host);
  els.siteHint.textContent =
    settings.defaultMode === 'on'
      ? listed
        ? 'Excluded from Text Only'
        : 'Following the on-by-default rule'
      : listed
        ? 'Whitelisted for Text Only'
        : 'Not in the whitelist';
}

function renderStatus(host) {
  if (dirty) {
    setStatus('waiting', 'Reload the page to apply');
    return;
  }
  if (!settings.enabled) {
    els.enabledLabel.textContent = 'Paused';
    setStatus('idle', 'Text Only is paused everywhere');
    return;
  }
  els.enabledLabel.textContent = 'Enabled';
  if (!host) {
    setStatus('idle', 'Nothing to change on this page');
    return;
  }
  if (decide(settings, host)) {
    setStatus('ok', `Text Only is active on ${host}`);
  } else {
    setStatus('idle', `Text Only is off on ${host}`);
  }
}

function render(host) {
  document.body.classList.toggle('is-disabled', !settings.enabled);
  els.enabled.checked = settings.enabled;
  els.blockVideo.checked = settings.blockVideo;
  applyTheme(settings.theme);
  const themeChoice = themeInputs.find(i => i.value === settings.theme);
  if (themeChoice) themeChoice.checked = true;
  renderList();
  renderSiteRow(host);
  renderStatus(host);
}

// ———————————————————————————————————— persistence ————————————————————————————————————

async function save(patch, needsReload = true) {
  dirty = needsReload;
  await chrome.storage.sync.set(patch);
  // storage.onChanged re-renders; nothing else to do here.
}

async function load() {
  const stored = await chrome.storage.sync.get(null);
  void chrome.runtime.lastError;
  settings = { ...DEFAULTS, ...stored };
  if (!Array.isArray(settings.sites)) settings.sites = [];
}

// ———————————————————————————————————— wiring ————————————————————————————————————

let currentHost = '';

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));

for (const input of modeInputs) {
  input.addEventListener('change', () => save({ defaultMode: input.value }));
}

els.blockVideo.addEventListener('change', () => save({ blockVideo: els.blockVideo.checked }));

els.siteToggle.addEventListener('change', () => {
  const listed = settings.sites.includes(currentHost);
  const sites = els.siteToggle.checked
    ? listed ? settings.sites : [...settings.sites, currentHost].sort()
    : settings.sites.filter(x => x !== currentHost);
  save({ sites });
});

function addFromInput() {
  const host = normalizeHost(els.siteInput.value);
  if (!host) return;
  if (!settings.sites.includes(host)) save({ sites: [...settings.sites, host].sort() });
  els.siteInput.value = '';
  els.siteInput.focus();
}

els.siteAdd.addEventListener('click', addFromInput);
els.siteInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') addFromInput();
});

for (const input of themeInputs) {
  input.addEventListener('change', () => {
    applyTheme(input.value);
    save({ theme: input.value }, false);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  if (!Array.isArray(settings.sites)) settings.sites = [];
  render(currentHost);
});

prefersLight.addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

// ———————————————————————————————————— init ————————————————————————————————————

// Popup bubble is ~288px wide; the full options tab is wider. Centering the
// same layout when wide keeps one HTML file serving both surfaces.
function applyWidthClass() {
  document.body.classList.toggle('as-page', window.innerWidth >= 480);
}
window.addEventListener('resize', applyWidthClass);

document.querySelector('.header__version').textContent = `v${chrome.runtime.getManifest().version}`;

(async function init() {
  applyWidthClass();
  await load();
  applyTheme(settings.theme);
  const tab = await activeTab();
  currentHost = hostOfTab(tab);
  render(currentHost);
})();
