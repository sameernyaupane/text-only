/****************************************************************
 * Text Only — content script
 *
 * Runs at document_start in every frame. Asks the background for this
 * frame's decision, stamps data-text-only on <html> (content.css reacts
 * to the attribute), and scrubs what CSS cannot reach: data:/blob:
 * image sources and dynamically inserted media.
 ****************************************************************/

let state = { active: false, blockVideo: true, blankUrl: '' };

let observer = null;

const DATA_IMG_SEL = 'img[src^="data:"], img[src^="blob:"]';
const MEDIA_SEL = `${DATA_IMG_SEL}, svg, video`;

function setDataAttribute() {
  document.documentElement.dataset.textOnly = state.active ? 'on' : 'off';
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
    for (const m of mutations) {
      for (const node of m.addedNodes) scrubTree(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObserving() {
  observer?.disconnect();
  observer = null;
}

function apply() {
  setDataAttribute();
  if (state.active) {
    scrubTree(document.documentElement);
    observe();
  } else {
    stopObserving();
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

requestState();
