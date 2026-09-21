/****************************************************************
 * Text Only — service worker
 *
 * Single source of truth for settings and for the declarativeNetRequest
 * rules that stop image/object/media requests from ever hitting the wire.
 * Content scripts ask "site-state" per frame; the popup and the context
 * menu mutate settings, and storage.onChanged rebuilds the rules here.
 ****************************************************************/

const DEFAULTS = {
  enabled: true, // master switch, like simple-auto-hd's extensionEnabled
  defaultMode: 'on', // 'on' = Text Only everywhere except listed sites; 'off' = only listed sites
  sites: [], // domains; meaning flips with defaultMode (exclusions vs whitelist)
  blockVideo: true, // also redirect <video>/media and object requests
  theme: 'system', // popup appearance: system | light | dark
  schemaVersion: 1,
};

const RULE_ID = 1;
const BLANK_URL = chrome.runtime.getURL('assets/blank.png');

// ————————————————————————————————————
// Settings
// ————————————————————————————————————

function sanitize(raw) {
  const s = { ...DEFAULTS, ...(raw ?? {}) };
  if (typeof s.enabled !== 'boolean') s.enabled = DEFAULTS.enabled;
  if (s.defaultMode !== 'on' && s.defaultMode !== 'off') s.defaultMode = DEFAULTS.defaultMode;
  if (!Array.isArray(s.sites)) s.sites = [];
  else s.sites = [...new Set(s.sites.filter(x => typeof x === 'string' && x !== ''))]
      .map(x => normalizeHost(x)).sort();
  if (typeof s.blockVideo !== 'boolean') s.blockVideo = DEFAULTS.blockVideo;
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  return s;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  void chrome.runtime.lastError;
  return sanitize(stored);
}

/** Seeds missing keys only, so an existing install never has a value overwritten. */
async function seedDefaults() {
  const stored = await chrome.storage.sync.get(null);
  void chrome.runtime.lastError;
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored?.[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length > 0) await chrome.storage.sync.set(patch);
}

/** "www.Example.com" -> "example.com"; also accepts full URLs. */
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

/**
 * The one decision everything agrees on.
 *   defaultMode 'on'  + not listed -> active
 *   defaultMode 'off' + listed     -> active
 * Mirrored in popup.js (status line); keep the two in sync.
 */
function decide(settings, host) {
  if (!settings.enabled || !host) return false;
  const listed = settings.sites.includes(host);
  return settings.defaultMode === 'on' ? !listed : listed;
}

// ————————————————————————————————————
// Blocking rules
// ————————————————————————————————————

function resourceTypesFor(s) {
  return s.blockVideo ? ['image', 'object', 'media'] : ['image', 'object'];
}

async function applyRules() {
  const s = await getSettings();
  const action = { type: 'redirect', redirect: { url: BLANK_URL } };

  let addRules = [];
  if (s.enabled) {
    const condition = { resourceTypes: resourceTypesFor(s) };
    if (s.defaultMode === 'on') {
      // Empty excludedInitiatorDomains would match nothing useful to omit:
      // absent key means "no exclusions", so only set it when non-empty.
      if (s.sites.length > 0) condition.excludedInitiatorDomains = s.sites;
    } else if (s.sites.length > 0) {
      condition.initiatorDomains = s.sites;
    }
    // defaultMode 'off' with an empty whitelist blocks nothing.
    if (s.defaultMode === 'on' || s.sites.length > 0) {
      addRules = [{ id: RULE_ID, priority: 1, action, condition }];
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules,
  });
}

// ————————————————————————————————————
// Toolbar icon reflects the current tab's state
// ————————————————————————————————————

const ICON_OFF = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
const ICON_ON = { 16: 'icons/icon16-on.png', 32: 'icons/icon32-on.png' };

// Content scripts report their frame's decision; the top frame drives the icon
// without the "tabs" permission.
function setTabIcon(tabId, active) {
  chrome.action.setIcon({ tabId, path: active ? ICON_ON : ICON_OFF }).catch(() => {});
}

// ————————————————————————————————————
// Messaging from content scripts
// ————————————————————————————————————

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'site-state') {
    getSettings().then(s => {
      const host = normalizeHost(msg.host) || normalizeHost(sender.url ?? '');
      sendResponse({
        active: decide(s, host),
        blockVideo: s.blockVideo,
        blankUrl: BLANK_URL,
      });
    });
    return true; // async sendResponse
  }

  if (msg?.type === 'icon-state' && sender.tab?.id !== undefined) {
    setTabIcon(sender.tab.id, msg.active === true);
  }
  return false;
});

// ————————————————————————————————————
// Context menu: toggle the current site + open settings
// ————————————————————————————————————

const MENU_TOGGLE = 'toggle-site';
const MENU_SETTINGS = 'open-settings';

async function toggleSite(url) {
  const host = normalizeHost(url);
  if (!host) return;
  const s = await getSettings();
  const listed = s.sites.includes(host);
  s.sites = listed ? s.sites.filter(x => x !== host) : [...s.sites, host].sort();
  await chrome.storage.sync.set({ sites: s.sites });
  // Rules rebuild via storage.onChanged; reload so replaced assets come back.
}

chrome.runtime.onInstalled.addListener(() => {
  seedDefaults().then(applyRules);
  chrome.contextMenus.create({ id: MENU_TOGGLE, title: 'Toggle Text Only on this site', contexts: ['page', 'image', 'video'] });
  chrome.contextMenus.create({ id: MENU_SETTINGS, title: 'Text Only settings', contexts: ['action'] });
});

chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') applyRules();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TOGGLE) {
    const url = info.pageUrl ?? tab?.url;
    toggleSite(url).then(() => {
      if (tab?.id !== undefined) chrome.tabs.reload(tab.id);
    });
  } else if (info.menuItemId === MENU_SETTINGS) {
    chrome.runtime.openOptionsPage();
  }
});

// ————————————————————————————————————

seedDefaults().then(applyRules);
