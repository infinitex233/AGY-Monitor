export const FLOATING_PANEL_STORAGE_KEY = 'agy-monitor.floating-panel.v1';

const FLOATING_PANEL_WIDTH = 580;
const FLOATING_PANEL_HEIGHT = 560;
const FLOATING_PANEL_MIN_WIDTH = 400;
const FLOATING_PANEL_MIN_HEIGHT = 340;
const FLOATING_PANEL_THRESHOLD = 4;

function clampFloatingValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getFloatingBounds({ width, height }) {
  const left = Math.min(12, Math.floor((width - 1) / 2));
  const top = Math.min(12, Math.floor((height - 1) / 2));
  return { left, top, right: width - left, bottom: height - top };
}

function fitFloatingRect(rect, bounds) {
  const width = Math.min(rect.width, bounds.right - bounds.left);
  const height = Math.min(rect.height, bounds.bottom - bounds.top);
  return {
    x: clampFloatingValue(rect.x, bounds.left, bounds.right - width),
    y: clampFloatingValue(rect.y, bounds.top, bounds.bottom - height),
    width,
    height,
  };
}

function getDefaultFloatingRect(bounds, scale, sidebarRight) {
  const right = Math.max(bounds.left + 1, bounds.right - 8);
  const sidebarClearance = sidebarRight + 12;
  const left = sidebarClearance < right ? Math.max(bounds.left, sidebarClearance) : bounds.left;
  const top = clampFloatingValue(
    52, bounds.top, Math.max(bounds.top, bounds.bottom - FLOATING_PANEL_MIN_HEIGHT)
  );
  const fitScale = Math.min(
    scale, (right - left) / FLOATING_PANEL_WIDTH, (bounds.bottom - top) / FLOATING_PANEL_HEIGHT
  );
  const width = Math.max(1, Math.floor(FLOATING_PANEL_WIDTH * fitScale));
  const height = Math.max(1, Math.floor(FLOATING_PANEL_HEIGHT * fitScale));
  return { x: right - width, y: top, width, height };
}

function normalizeSavedRect(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const { x, y, width, height } = candidate;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function loadFloatingPanelState(getStorage) {
  try {
    const state = JSON.parse(getStorage()?.getItem(FLOATING_PANEL_STORAGE_KEY) ?? 'null');
    if (!state || typeof state !== 'object') return null;
    const rect = state.rect === null ? null : normalizeSavedRect(state.rect);
    if (state.rect !== null && !rect) return null;
    return { rect, collapsed: state.collapsed === true, locked: state.locked === true };
  } catch {
    return null;
  }
}

/**
 * Tracks the preferred expanded rect independently of its current viewport fit.
 * The badge shares its position, so dragging it moves the next expanded window.
 */
export function createFloatingPanelController({
  bar,
  pill,
  handles,
  getViewport,
  getSidebarRight = () => 0,
  getScale = () => 1,
  getStorage = () => window.localStorage,
  onLayout,
}) {
  const saved = loadFloatingPanelState(getStorage);
  let preferredRect = saved?.rect ?? null;
  let collapsed = saved?.collapsed ?? false;
  let locked = saved?.locked ?? false;
  let lastLayout = null;
  let gesture = null;
  let suppressPillClick = false;

  function getDefaultRect(viewport, bounds) {
    return getDefaultFloatingRect(bounds, getScale(), getSidebarRight(viewport.width));
  }

  function persist(patch) {
    try {
      const base = loadFloatingPanelState(getStorage) ?? { rect: preferredRect, collapsed, locked };
      getStorage()?.setItem(FLOATING_PANEL_STORAGE_KEY, JSON.stringify({ ...base, ...patch }));
    } catch {
      // Keep the window interactive when host storage is unavailable.
    }
  }

  function reflow(forceRefresh = false) {
    const viewport = getViewport();
    const bounds = getFloatingBounds(viewport);
    const rect = preferredRect ?? getDefaultRect(viewport, bounds);
    const size = collapsed
      ? { width: Math.round(216 * getScale()), height: Math.round(36 * getScale()) }
      : rect;
    const next = { ...fitFloatingRect({ ...rect, ...size }, bounds), collapsed, locked };
    const previous = lastLayout;
    if (!forceRefresh && previous && Object.keys(next).every((key) => previous[key] === next[key])) {
      return;
    }
    lastLayout = next;
    const refreshContent = !collapsed && (
      forceRefresh || !previous || previous.collapsed ||
      previous.width !== next.width || previous.height !== next.height
    );
    onLayout(next, refreshContent);
  }

  function updateGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { start, rect, edges, initialRect } = gesture;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!gesture.moved && Math.hypot(dx, dy) < FLOATING_PANEL_THRESHOLD) return;
    gesture.moved = true;
    if (gesture.target === pill) suppressPillClick = true;

    const bounds = getFloatingBounds(getViewport());
    if (edges) {
      const availableWidth = Math.max(1, bounds.right - rect.x);
      const availableHeight = Math.max(1, bounds.bottom - rect.y);
      preferredRect = {
        x: initialRect.x,
        y: initialRect.y,
        width: edges.includes('right')
          ? clampFloatingValue(rect.width + dx, Math.min(FLOATING_PANEL_MIN_WIDTH, availableWidth), availableWidth)
          : initialRect.width,
        height: edges.includes('bottom')
          ? clampFloatingValue(rect.height + dy, Math.min(FLOATING_PANEL_MIN_HEIGHT, availableHeight), availableHeight)
          : initialRect.height,
      };
    } else {
      const fitted = fitFloatingRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
      preferredRect = { ...initialRect, x: fitted.x, y: fitted.y };
    }
    reflow();
  }

  function endGesture(commit) {
    if (!gesture) return;
    const { moved, target, pointerId, previousRect } = gesture;
    gesture = null;
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    if (!moved) return;
    if (commit) {
      persist({ rect: preferredRect });
    } else {
      preferredRect = previousRect;
      reflow();
    }
  }

  function setCollapsed(next) {
    if (collapsed === next) return;
    endGesture(false);
    collapsed = next;
    persist({ collapsed });
    reflow();
  }

  const unbind = [[bar], [pill], ...handles].map(([target, edges]) => {
    const onDown = (event) => {
      if (gesture || event.button !== 0 || event.isPrimary === false) return;
      if (target === pill) suppressPillClick = false;
      if (locked || (target === bar && event.target?.closest?.('button'))) return;
      if (!lastLayout) reflow();
      const viewport = getViewport();
      const rect = preferredRect ?? getDefaultRect(viewport, getFloatingBounds(viewport));
      target.setPointerCapture?.(event.pointerId);
      gesture = {
        target,
        edges,
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        rect: lastLayout,
        initialRect: rect,
        previousRect: preferredRect,
        moved: false,
      };
    };
    const onUp = (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      updateGesture(event);
      endGesture(true);
    };
    const onCancel = (event) => {
      if (event.pointerId === gesture?.pointerId) endGesture(false);
    };
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', updateGesture);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onCancel);
    target.addEventListener('lostpointercapture', onCancel);
    return () => {
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', updateGesture);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onCancel);
      target.removeEventListener('lostpointercapture', onCancel);
    };
  });

  function onPillClick(event) {
    if (event.detail > 0 && suppressPillClick) return;
    setCollapsed(false);
  }
  pill.addEventListener('click', onPillClick);

  return {
    reflow,
    setCollapsed,
    toggleLocked() {
      endGesture(false);
      locked = !locked;
      persist({ locked });
      reflow();
    },
    reset() {
      endGesture(false);
      preferredRect = null;
      persist({ rect: null });
      reflow(true);
    },
    dispose() {
      for (const remove of unbind) remove();
      pill.removeEventListener('click', onPillClick);
      endGesture(false);
    },
  };
}
