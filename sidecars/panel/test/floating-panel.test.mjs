import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFloatingPanelController,
  FLOATING_PANEL_STORAGE_KEY,
} from '../src/components/layout/floatingPanelController.js';
import { resolveActiveDockTarget } from '../src/components/layout/overlayHostAnchors.js';
import { mountWindowOverlay } from '../src/components/layout/WindowOverlayShell.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { telemetryStore } from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';
import { WINDOW_BRIDGE_KEY } from '../shared/window-bridge-protocol.mjs';
import { createMockDom, MockDomNode } from './mock-dom.mjs';

const DEFAULT_LAYOUT = { x: 680, y: 52, width: 580, height: 560, collapsed: false, locked: false };

function makeStorage(initialValue = null) {
  let value = initialValue;
  const writes = [];
  return {
    writes,
    getItem(key) {
      assert.equal(key, FLOATING_PANEL_STORAGE_KEY);
      return value;
    },
    setItem(key, nextValue) {
      assert.equal(key, FLOATING_PANEL_STORAGE_KEY);
      writes.push(JSON.parse(nextValue));
      value = nextValue;
    },
  };
}

function trackPointerCapture(node) {
  let pointer = null;
  node.setPointerCapture = (id) => { pointer = id; };
  node.hasPointerCapture = (id) => pointer === id;
  node.releasePointerCapture = (id) => {
    assert.equal(pointer, id);
    pointer = null;
  };
  return node;
}

function pointer(target, type, clientX, clientY, props = {}) {
  target.dispatchEvent({ type, target, button: 0, pointerId: 1, clientX, clientY, ...props });
}

function drag(target, dx, dy) {
  pointer(target, 'pointerdown', 0, 0);
  pointer(target, 'pointermove', dx, dy);
  pointer(target, 'pointerup', dx, dy);
}

function makeController(t, { storage = makeStorage(), ...options } = {}) {
  const viewport = { width: 1280, height: 800 };
  const bar = trackPointerCapture(new MockDomNode());
  const pill = trackPointerCapture(new MockDomNode('button'));
  const handles = ['right', 'bottom', 'bottom-right'].map((edge) => [
    trackPointerCapture(new MockDomNode()), edge,
  ]);
  const [right, bottom, corner] = handles.map(([node]) => node);
  const layouts = [];
  const controller = createFloatingPanelController({
    bar,
    pill,
    handles,
    getViewport: () => viewport,
    getStorage: () => storage,
    onLayout: (layout, refreshContent) => layouts.push({ layout, refreshContent }),
    ...options,
  });
  t.after(() => controller.dispose());
  controller.reflow();
  return {
    bar, pill, right, bottom, corner, controller, viewport, storage, layouts,
    layout: () => layouts.at(-1).layout,
  };
}

test('floating default has a scaled aspect ratio, clears the left sidebar and fits small viewports', (t) => {
  const normal = makeController(t);
  assert.deepEqual(normal.layout(), DEFAULT_LAYOUT);
  const scaled = makeController(t, { getScale: () => 1.25, getSidebarRight: () => 490 });
  assert.deepEqual(scaled.layout(), { ...DEFAULT_LAYOUT, x: 535, width: 725, height: 700 });
  scaled.viewport.width = 1020;
  scaled.controller.reflow();
  const narrow = scaled.layout();
  assert.ok(narrow.x >= 502);
  assert.equal(narrow.x + narrow.width, 1000);
  assert.ok(Math.abs(narrow.width / narrow.height - 580 / 560) < 0.005);
  scaled.viewport.width = 800;
  scaled.controller.reflow();
  assert.ok(scaled.layout().x >= 502);
  assert.equal(scaled.layout().x + scaled.layout().width, 780);
  scaled.viewport.width = 214;
  scaled.viewport.height = 176;
  scaled.controller.reflow();
  const small = scaled.layout();
  assert.ok(small.x >= 12 && small.x + small.width <= 202);
  assert.ok(small.y >= 12 && small.y + small.height <= 164);
});

test('floating drag and resize clamp the rect and persist only completed gestures', (t) => {
  const { bar, right, bottom, corner, storage, layout, layouts, controller, viewport } = makeController(t);
  pointer(bar, 'pointerdown', 680, 52);
  assert.equal(bar.hasPointerCapture(1), true);
  pointer(bar, 'pointermove', 682, 53);
  assert.deepEqual(layout(), DEFAULT_LAYOUT);
  pointer(bar, 'pointermove', 100, 100, { pointerId: 2 });
  assert.deepEqual(layout(), DEFAULT_LAYOUT);
  pointer(bar, 'pointermove', 100, 100);
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 100, y: 100 });
  assert.equal(layouts.at(-1).refreshContent, false);
  assert.equal(storage.writes.length, 0);
  pointer(bar, 'pointerup', 100, 100);
  assert.equal(bar.hasPointerCapture(1), false);
  assert.deepEqual(storage.writes, [
    { rect: { x: 100, y: 100, width: 580, height: 560 }, collapsed: false, locked: false },
  ]);

  drag(right, -900, 400);
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 100, y: 100, width: 400 });
  assert.equal(layouts.at(-1).refreshContent, true);
  drag(bottom, 400, -900);
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 100, y: 100, width: 400, height: 340 });
  drag(corner, 9000, 9000);
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 100, y: 100, width: 1168, height: 688 });
  drag(bar, -500, -500);
  assert.equal(layout().x, 12);
  assert.equal(layout().y, 12);
  drag(bar, 500, 500);
  assert.equal(layout().x, 100);
  assert.equal(layout().y, 100);
  const saved = layout();
  const savedRecord = {
    rect: { x: saved.x, y: saved.y, width: saved.width, height: saved.height },
    collapsed: false,
    locked: false,
  };

  pointer(bar, 'pointerdown', 0, 0);
  pointer(bar, 'pointermove', -30, -20);
  pointer(bar, 'pointercancel', -30, -20);
  assert.deepEqual(layout(), saved);
  assert.equal(bar.hasPointerCapture(1), false);
  assert.deepEqual(storage.writes.at(-1), savedRecord);

  viewport.width = 600;
  viewport.height = 430;
  controller.reflow();
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 12, y: 12, width: 576, height: 406 });
  viewport.width = 1280;
  viewport.height = 800;
  controller.reflow();
  assert.deepEqual(layout(), saved);

  // Bottom-only resize while viewport is temporarily narrowed preserves preferred x
  drag(right, -600, 0);
  drag(bar, 400, 0);
  const preNarrow = layout();
  assert.equal(preNarrow.x, 500);
  viewport.width = 480;
  controller.reflow();
  assert.equal(layout().x, 12);
  drag(bottom, 0, -100);
  viewport.width = 1280;
  controller.reflow();
  assert.equal(layout().x, 500);
  assert.equal(layout().height, preNarrow.height - 100);
});

test('floating lock blocks pointer changes, reset keeps default dynamic after reload, and the badge distinguishes drag from click', (t) => {
  const { bar, pill, corner, layout, layouts, storage, controller } = makeController(t);
  const innerButton = new MockDomNode('button');
  pointer(bar, 'pointerdown', 0, 0, { target: innerButton });
  assert.equal(bar.hasPointerCapture(1), false);

  drag(bar, -160, 150);
  controller.toggleLocked();
  const locked = { ...DEFAULT_LAYOUT, x: 520, y: 202, locked: true };
  assert.deepEqual(layout(), locked);
  drag(bar, -120, -30);
  drag(corner, -120, -30);
  assert.deepEqual(layout(), locked);
  controller.reset();
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, locked: true });
  assert.deepEqual(storage.writes.at(-1), { rect: null, collapsed: false, locked: true });
  assert.equal(layouts.at(-1).refreshContent, true);

  // Reloading after reset at a wider viewport computes the fresh default instead of freezing 1280px geometry
  const wideReload = makeController(t, {
    storage,
    getViewport: () => ({ width: 1600, height: 800 }),
  });
  assert.deepEqual(wideReload.layout(), {
    x: 1000, y: 52, width: 580, height: 560, collapsed: false, locked: true,
  });

  controller.setCollapsed(true);
  drag(pill, 300, 300);
  assert.equal(layout().x, 680);
  pill.dispatchEvent({ type: 'click', detail: 1 });
  assert.equal(layout().collapsed, false);
  controller.toggleLocked();
  controller.setCollapsed(true);
  drag(pill, 400, 900);
  assert.deepEqual(layout(), { x: 1052, y: 752, width: 216, height: 36, collapsed: true, locked: false });
  assert.deepEqual(storage.writes.at(-1), {
    rect: { x: 1052, y: 752, width: 580, height: 560 },
    collapsed: true,
    locked: false,
  });
  pill.dispatchEvent({ type: 'click', detail: 1 });
  assert.equal(layout().collapsed, true);
  pointer(pill, 'pointerdown', 20, 20);
  pointer(pill, 'pointerup', 22, 21);
  pill.dispatchEvent({ type: 'click', detail: 1 });
  assert.deepEqual(layout(), { ...DEFAULT_LAYOUT, x: 688, y: 228 });
});

test('floating merges cross-window storage updates, tolerates corrupt or unavailable storage, and discards mid-drag on dispose', (t) => {
  const storage = makeStorage();
  const winA = makeController(t, { storage });
  const winB = makeController(t, { storage });
  drag(winA.bar, -380, 20);
  assert.equal(winA.layout().x, 300);
  // Window B toggles lock without clobbering Window A's saved rect
  winB.controller.toggleLocked();
  assert.deepEqual(storage.writes.at(-1), {
    rect: { x: 300, y: 72, width: 580, height: 560 },
    collapsed: false,
    locked: true,
  });

  const original = makeController(t, { storage: makeStorage() });
  drag(original.bar, -120, 20);
  original.controller.setCollapsed(true);
  original.controller.toggleLocked();
  const reopened = makeController(t, { storage: original.storage });
  assert.deepEqual(reopened.layout(), original.layout());
  reopened.pill.dispatchEvent({ type: 'click', detail: 0 });
  assert.deepEqual(reopened.layout(), { ...DEFAULT_LAYOUT, x: 560, y: 72, locked: true });

  for (const invalid of ['not JSON', '{"rect":{"x":10,"y":10,"width":-1,"height":20}}']) {
    assert.deepEqual(makeController(t, { storage: makeStorage(invalid) }).layout(), DEFAULT_LAYOUT);
  }
  const denied = makeController(t, { getStorage: () => { throw new Error('Access denied'); } });
  assert.deepEqual(denied.layout(), DEFAULT_LAYOUT);
  const disposalStorage = makeStorage();
  const midDrag = makeController(t, { storage: disposalStorage });
  pointer(midDrag.bar, 'pointerdown', 0, 0);
  pointer(midDrag.bar, 'pointermove', -100, 35);
  assert.equal(midDrag.layout().x, 580);
  midDrag.controller.dispose();
  assert.equal(midDrag.bar.hasPointerCapture(1), false);
  assert.equal(disposalStorage.writes.length, 0);
  assert.deepEqual(midDrag.layout(), DEFAULT_LAYOUT);
  drag(midDrag.bar, -300, -200);
  assert.deepEqual(midDrag.layout(), DEFAULT_LAYOUT);
});

test('floating dock resolution bypasses titlebar and composer queries and excludes IDE chat frames', (t) => {
  const previous = { window: globalThis.window, document: globalThis.document };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.window = { [WINDOW_BRIDGE_KEY]: { mountMode: 'floating' } };
  globalThis.document = { querySelector: () => assert.fail('unexpected dock query') };
  assert.deepEqual(resolveActiveDockTarget(), {
    kind: 'floating', workbench: null, titlebar: null, targetContainer: null, actionToolbar: null,
  });
  window[WINDOW_BRIDGE_KEY].isIdeChatFrame = true;
  assert.equal(resolveActiveDockTarget(), null);
});

test('floating shell stays visible until minimized and cleans up on live mount mode switches', (t) => {
  const previous = { window: globalThis.window, document: globalThis.document };
  const previousTelemetry = telemetryStore.getState();
  const previousUi = uiStore.getState();
  const previousLanguage = i18nStore.getState().language;
  setI18nLanguage('en-US');
  const { document, docListeners } = createMockDom();
  const windowEvents = new EventTarget();
  const storage = makeStorage();
  let telemetry = {
    settings: { language: 'en-US', windowMountMode: 'floating', enableWindowOverlay: true },
    activeConversation: { stepCount: 1, isRunning: true, latestTokPerSec: 42 },
  };
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200, json: async () => telemetry,
  }));
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: storage,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    [WINDOW_BRIDGE_KEY]: { mountMode: 'floating', port: 43111, token: 'test', initialTelemetry: telemetry },
  };
  let overlay;
  t.after(() => {
    overlay?.dispose();
    Object.assign(globalThis, previous);
    telemetryStore.setState(previousTelemetry, { sync: true });
    uiStore.setState(previousUi, { sync: true });
    setI18nLanguage(previousLanguage);
  });

  overlay = mountWindowOverlay();
  const capsule = document.getElementById('ag-usage-monitor-capsule');
  const portal = document.getElementById('ag-usage-monitor-portal');
  const popover = portal.shadowRoot.querySelector('.wm-popover-panel');
  const app = popover.querySelector('.app-shell');
  const pill = portal.shadowRoot.querySelector('.wm-floating-pill');
  const bar = trackPointerCapture(popover.querySelector('.wm-floating-bar'));
  const [lock, reset, collapse] = bar.querySelectorAll('button');
  assert.ok(app);
  assert.ok(bar.querySelector('.wm-floating-logo'));
  assert.ok(pill.querySelector('.wm-floating-pill-logo'));
  assert.ok(app.querySelector('.settings-version-logo'));
  assert.equal(overlay.getDockKind(), 'floating');
  assert.equal(capsule.style.display, 'none');
  assert.equal(overlay.isOpen(), true);
  assert.equal(uiStore.getState().monitorVisible, true);
  assert.equal(popover.style.width, '580px');
  assert.equal(popover.style.height, '560px');
  assert.equal(pill.hasAttribute('hidden'), true);

  document.dispatchEvent({ type: 'mousedown', target: document.body });
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(overlay.isOpen(), true);
  assert.equal(uiStore.getState().monitorVisible, true);

  document.hidden = true;
  document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(uiStore.getState().monitorVisible, false);
  document.hidden = false;
  document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(uiStore.getState().monitorVisible, true);

  lock.dispatchEvent({ type: 'click' });
  assert.equal(lock.getAttribute('aria-pressed'), 'true');
  assert.equal(lock.getAttribute('aria-label'), 'Unlock position and size');
  reset.dispatchEvent({ type: 'click' });
  collapse.dispatchEvent({ type: 'click' });
  assert.equal(popover.hasAttribute('hidden'), true);
  assert.equal(pill.hasAttribute('hidden'), false);
  assert.equal(uiStore.getState().monitorVisible, false);
  assert.equal(pill.getAttribute('aria-label'), 'Expand floating monitor');
  const tps = pill.querySelector('[data-metric="tps"] .wm-slot-text');
  assert.match(tps.getAttribute('data-od-value'), /42/);
  telemetry = { ...telemetry, activeConversation: { ...telemetry.activeConversation, latestTokPerSec: 91 } };
  telemetryStore.setState({ telemetry }, { sync: true });
  assert.match(tps.getAttribute('data-od-value'), /91/);
  pill.dispatchEvent({ type: 'click', detail: 1 });
  assert.equal(popover.querySelector('.app-shell'), app);
  assert.equal(uiStore.getState().monitorVisible, true);

  window.innerWidth = 480;
  window.innerHeight = 420;
  windowEvents.dispatchEvent(new Event('resize'));
  assert.ok(parseInt(popover.style.left, 10) + parseInt(popover.style.width, 10) <= 468);
  assert.ok(parseInt(popover.style.top, 10) + parseInt(popover.style.height, 10) <= 408);

  lock.dispatchEvent({ type: 'click' });
  pointer(bar, 'pointerdown', 0, 0);
  assert.equal(bar.hasPointerCapture(1), true);
  assert.equal(overlay.applyMountMode('dual'), true);
  assert.equal(bar.hasPointerCapture(1), false);
  assert.equal(popover.classList.contains('is-floating'), false);
  assert.equal(popover.classList.contains('is-locked'), false);
  assert.equal(popover.style.width, '');
  assert.equal(popover.style.height, '');
  assert.equal(portal.shadowRoot.querySelector('.wm-floating-pill'), null);
  assert.equal(capsule.style.display, '');
  assert.equal(uiStore.getState().monitorVisible, false);
  overlay.open();
  assert.equal(overlay.isOpen(), true);
  document.dispatchEvent({ type: 'mousedown', target: document.body });
  assert.equal(overlay.isOpen(), false);

  overlay.openMulti();
  assert.equal(overlay.isMultiOpen(), true);
  assert.equal(overlay.applyMountMode('float'), true);
  assert.equal(overlay.isMultiOpen(), false);
  assert.equal(overlay.getMountMode(), 'floating');
  assert.equal(uiStore.getState().monitorVisible, true);
  assert.equal(overlay.applyMountMode('sidebar'), true);
  assert.equal(capsule.style.display, 'none');
  assert.equal(popover.classList.contains('is-floating'), false);
  assert.equal(uiStore.getState().monitorVisible, false);
  assert.equal(overlay.applyMountMode('floating'), true);
  assert.equal(overlay.isOpen(), true);
  assert.equal(popover.querySelector('.app-shell'), app);

  // Live switch from an open dual panel into floating keeps the panel expanded even if collapsed was saved
  popover.querySelectorAll('.wm-floating-bar button')[2].dispatchEvent({ type: 'click' });
  assert.equal(popover.hasAttribute('hidden'), true);
  assert.equal(overlay.applyMountMode('dual'), true);
  overlay.open();
  assert.equal(overlay.isOpen(), true);
  assert.equal(overlay.applyMountMode('floating'), true);
  assert.equal(overlay.isOpen(), true);
  assert.equal(popover.hasAttribute('hidden'), false);

  // Unrelated waiting session does not mark the displayed generating session as waiting
  const summaryEl = popover.querySelector('.wm-floating-bar .wm-floating-summary');
  telemetry = {
    ...telemetry,
    activeConversation: {
      cascadeId: 'conv-generating',
      stepCount: 1,
      isRunning: true,
      latestTokPerSec: 42,
      mainActivity: { phase: 'generating' },
    },
    runningConversations: [
      { cascadeId: 'conv-generating', isRunning: true, mainActivity: { phase: 'generating' } },
      { cascadeId: 'conv-other-waiting', isRunning: true, mainActivity: { phase: 'waiting' } },
    ],
  };
  telemetryStore.setState({ telemetry }, { sync: true });
  assert.equal(summaryEl.classList.contains('is-running'), true);
  assert.equal(summaryEl.classList.contains('is-waiting'), false);

  // Default floating panel geometry refreshes when host sidebar disappears and ensureAlive() runs
  window.innerWidth = 1000;
  window.innerHeight = 800;
  const nav = document.createElement('div');
  nav.setAttribute('role', 'navigation');
  nav.getBoundingClientRect = () => ({ left: 0, right: 520, top: 0, bottom: 800, width: 520, height: 800 });
  document.body.appendChild(nav);
  popover.querySelectorAll('.wm-floating-bar button')[1].dispatchEvent({ type: 'click' });
  const narrowedWidth = parseInt(popover.style.width, 10);
  assert.ok(narrowedWidth < 500);
  nav.remove();
  overlay.ensureAlive();
  assert.equal(parseInt(popover.style.width, 10), 580);

  overlay.dispose();
  assert.equal(uiStore.getState().monitorVisible, false);
  assert.equal(document.getElementById('ag-usage-monitor-portal'), null);
  assert.equal(docListeners.get('mousedown').length, 0);
});
