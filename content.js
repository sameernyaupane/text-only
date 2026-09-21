/****************************************************************
 * Text Only — content script
 *
 * Runs at document_start in every frame. Asks the background for this
 * frame's decision, stamps data-text-only on <html> (content.css reacts
 * to the attribute), and scrubs what CSS cannot reach: data:/blob:
 * image sources and dynamically inserted media.
 *
 * Dark Reader coexistence: when Dark Reader is present on the page we
 * stamp data-dr as well, and content.css then leaves ALL color work
 * (backgrounds, grayscale, shadows) to Dark Reader, keeping only the
 * media removal.
 ****************************************************************/

let state = { active: false, blockVideo: true, blankUrl: '' };

let observer = null;

const DATA_IMG_SEL = 'img[src^="data:"], img[src^="blob:"]';
const MEDIA_SEL = `${DATA_IMG_SEL}, svg, video`;

// The markers Dark Reader leaves on a page, in any of its modes.
const DARKREADER_SEL =
  'meta[name="darkreader"], style[class*="darkreader"], [data-darkreader-mode]';

function setDataAttribute() {
  document.documentElement.dataset.textOnly = state.active ? 'on' : 'off';
}

/**
 * Recomputed on mutations as well as on apply(), because extension
 * content-script order is unspecified: Dark Reader's markers may land
 * after our document_start pass.
 */
function updateDarkReader() {
  const el = document.documentElement;
  if (state.active && el.querySelector(DARKREADER_SEL)) {
    el.dataset.dr = 'on';
  } else {
    delete el.dataset.dr;
  }
}

function scrubOne(el) {
  if (el instanceof HTMLImageElement) el.src = state.blankUrl;
  else if (el instanceof SVGSVGElement) el.setAttribute('data-text-only-scrubbed', '');
  else if (el instanceof HTMLVideoElement) {
    try {
      el.pause();
    } catch {
      /* detached */
    }
  }
}

/** The node itself, then anything matching inside its subtree. */
function scrubTree(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (node.matches(MEDIA_SEL)) scrubOne(node);
  for (const el of node.querySelectorAll(MEDIA_SEL)) scrubOne(el);
}

function observe() {
  if (!state.active || observer) return;
  observer = new MutationObserver(mutations => {
    updateDarkReader();
    for (const m of mutations) {
      if (m.type === 'attributes') continue;
      for (const node of m.addedNodes) scrubTree(node);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    // Excludes our own data-dr writes, so the observer never self-triggers.
    attributeFilter: ['data-darkreader-mode', 'data-darkreader-scheme', 'class', 'style'],
  });
}

function stopObserving() {
  observer?.disconnect();
  observer = null;
}

function apply() {
  setDataAttribute();
  if (state.active) {
    updateDarkReader();
    scrubTree(document.documentElement);
    observe();
  } else {
    stopObserving();
    delete document.documentElement.dataset.dr;
  }
  // Top frame drives the toolbar icon; needs no "tabs" permission this way.
  if (window.top === window.self) {
    chrome.runtime.sendMessage({ type: 'icon-state', active: state.active }).catch(() => {});
  }
}

function requestState() {
  chrome.runtime
    .sendMessage({ type: 'site-state', host: location.hostname })
    .then(next => {
      state = next;
      apply();
    })
    .catch(() => {}); // extension reloaded; page catches up on next navigation
}

chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'sync') requestState();
});

// Dark Reader may finish processing the page well after document_start.
document.addEventListener('DOMContentLoaded', updateDarkReader);

requestState();
