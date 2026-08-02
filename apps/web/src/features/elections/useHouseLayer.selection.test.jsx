/**
 * Picking a building off the map.
 *
 * The whole module hangs off this one gesture: nothing in the card, the tabs or
 * the quick actions can be reached until a house is selected, so a click that
 * does not land is the difference between a working feature and a dead one.
 *
 * The regression this file exists for: the long-press preview was armed for
 * every pointing device and for every press over 450 ms, and then it swallowed
 * the click that ended the press. A deliberate mouse click on a small building
 * routinely takes longer than that — so aiming carefully at a house outline
 * stopped opening its card, while a careless quick click still worked. The
 * suppression flag was not tied to the gesture that set it either, so it could
 * go on to eat an unrelated click later.
 *
 * The map is driven here as a browser drives it: real DOM events on Leaflet's
 * canvas, in the order a mouse and a finger actually produce them.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import L from 'leaflet';

import { LONG_PRESS_MS, findHouseAt, useHouseLayer } from './useHouseLayer.js';

const SIZE = { width: 800, height: 600 };
const CENTER = { lat: 50.45, lon: 30.52 };

/*
 * jsdom has no canvas and no layout, and Leaflet needs both to project a
 * latitude onto a pixel. None of it is under test — the stubs only give the map
 * a size and somewhere to draw.
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => ({
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    fill: () => {},
    stroke: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    translate: () => {},
    scale: () => {},
    setTransform: () => {},
    clip: () => {},
    rect: () => {},
  });

  window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  for (const [property, value] of [
    ['clientWidth', SIZE.width],
    ['clientHeight', SIZE.height],
    ['offsetWidth', SIZE.width],
    ['offsetHeight', SIZE.height],
  ]) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get: () => value,
    });
  }

  HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: SIZE.width,
    bottom: SIZE.height,
    width: SIZE.width,
    height: SIZE.height,
  });
});

/** A square building around a point a little way off the centre. */
function makeHouse(id, offsetLat = 0, offsetLon = 0) {
  const lat = CENTER.lat + offsetLat;
  const lon = CENTER.lon + offsetLon;
  const half = 0.0003;

  return {
    id,
    number: String(id),
    address: `вул. Тестова, ${id}`,
    location: { lat, lon },
    footprint: [
      { lat: lat - half, lon: lon - half },
      { lat: lat - half, lon: lon + half },
      { lat: lat + half, lon: lon + half },
      { lat: lat + half, lon: lon - half },
    ],
    quality: [],
    campaign: {
      stage: 'not_started',
      priority: 'medium',
      assignees: [{ email: 'field@avku.org' }],
      overdueTasksCount: 0,
      openIssuesCount: 0,
      openTasksCount: 0,
      todayTasksCount: 0,
      lastActionAt: null,
      nextActionAt: null,
    },
  };
}

const HOUSE_A = makeHouse('a');
/* Far enough from A to be a different building, near enough to stay on screen
 * at the zoom below — a house the view cannot reach is not a test of anything. */
const HOUSE_B = makeHouse('b', 0.0005, 0.001);

let map = null;

function Layer(props) {
  const api = useHouseLayer({
    map,
    houses: props.houses,
    matchedIds: props.matchedIds,
    selectedHouseId: props.selectedHouseId ?? null,
    hoveredHouseId: null,
    onSelectHouse: props.onSelectHouse,
    onHoverHouse: props.onHoverHouse ?? (() => {}),
    onLongPressHouse: props.onLongPressHouse ?? (() => {}),
    isSelectionEnabled: props.isSelectionEnabled ?? true,
  });

  props.onApi?.(api);

  return null;
}

/** Mounts the layer over a real Leaflet map, close enough in to hit a house. */
function mountLayer(overrides = {}) {
  const container = document.createElement('div');

  document.body.append(container);

  map = L.map(container, {
    center: [CENTER.lat, CENTER.lon],
    zoom: 18,
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
  });

  const houses = overrides.houses ?? [HOUSE_A, HOUSE_B];
  const api = {};
  const props = {
    houses,
    matchedIds: overrides.matchedIds ?? new Set(houses.map((house) => house.id)),
    onSelectHouse: vi.fn(),
    onLongPressHouse: vi.fn(),
    onApi: (value) => Object.assign(api, value),
    ...overrides,
  };

  const view = render(<Layer {...props} />);

  // The hook binds its handlers once the map exists, which is one commit later.
  view.rerender(<Layer {...props} />);

  return {
    ...props,
    api,
    view,
    rerender: (next) => view.rerender(<Layer {...props} {...next} />),
  };
}

/** Where a house sits on screen right now. */
function pointOf(house) {
  return map.latLngToContainerPoint([house.location.lat, house.location.lon]);
}

function dispatch(type, { x, y, pointerType = 'mouse', pointerId = 1 }) {
  const Constructor = window.PointerEvent ?? window.MouseEvent;
  const event = new Constructor(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId,
    pointerType,
  });

  // jsdom's MouseEvent fallback drops the pointer fields from the init dict.
  if (!('pointerType' in event) || event.pointerType === undefined) {
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
  }

  const target = type.startsWith('pointer')
    ? map.getContainer()
    : map.getContainer().querySelector('canvas');

  target.dispatchEvent(event);
}

/**
 * One press with a mouse, held for `holdMs`.
 *
 * The order is the browser's: the pointer event first, then the mouse events it
 * is paired with, then the click that ends the gesture.
 */
async function pressWithMouse(house, holdMs = 40) {
  const { x, y } = pointOf(house);
  const at = { x, y, pointerType: 'mouse' };

  await act(async () => {
    dispatch('pointerdown', at);
    dispatch('mousedown', at);
    vi.advanceTimersByTime(holdMs);
    dispatch('pointerup', at);
    dispatch('mouseup', at);
    dispatch('click', at);
  });
}

/**
 * One press with a finger, held for `holdMs`.
 *
 * `compatibilityEvents` is the whole of the second bug: a touchscreen raises
 * `mousedown`/`mouseup`/`click` only when the finger comes off, and only when
 * the browser judges the press to have been a fast tap. Firefox stops sending
 * them at around a quarter of a second — so a press held any longer than that
 * arrives as the four pointer and touch events and nothing else.
 */
async function pressWithFinger(
  house,
  holdMs = 40,
  { liftOff = true, compatibilityEvents = true } = {},
) {
  const { x, y } = pointOf(house);
  const at = { x, y, pointerType: 'touch', pointerId: 7 };

  await act(async () => {
    dispatch('pointerdown', at);
    vi.advanceTimersByTime(holdMs);

    if (!liftOff) {
      return;
    }

    dispatch('pointerup', at);

    if (compatibilityEvents) {
      dispatch('mousedown', at);
      dispatch('mouseup', at);
      dispatch('click', at);
    }
  });
}

/** A click on ground no building covers. */
async function clickOpenGround() {
  const at = { x: 4, y: 4, pointerType: 'mouse' };

  await act(async () => {
    dispatch('pointerdown', at);
    dispatch('mousedown', at);
    dispatch('pointerup', at);
    dispatch('mouseup', at);
    dispatch('click', at);
  });
}

/** The same, with a finger and no compatibility events. */
async function tapOpenGround() {
  const at = { x: 4, y: 4, pointerType: 'touch', pointerId: 7 };

  await act(async () => {
    dispatch('pointerdown', at);
    vi.advanceTimersByTime(60);
    dispatch('pointerup', at);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  map?.remove();
  map = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('clicking a building', () => {
  it('selects the one under the pointer', async () => {
    const layer = mountLayer();

    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });

  /*
   * The reported bug. Nobody clicks in under half a second when they are aiming
   * at a building a few pixels across, and a press that lingers is still a
   * click — it must not turn into a different gesture.
   */
  it('selects it however long the button is held down', async () => {
    for (const holdMs of [40, 300, LONG_PRESS_MS + 200, 1500]) {
      const layer = mountLayer();

      await pressWithMouse(HOUSE_A, holdMs);

      expect(layer.onSelectHouse, `held for ${holdMs}ms`).toHaveBeenCalledWith('a');

      cleanup();
      map.remove();
      map = null;
    }
  });

  /* A mouse has the hover tooltip already; reading a slow click as a request
   * for a preview is what cost it the selection. */
  it('never turns a slow mouse press into a long press', async () => {
    const layer = mountLayer();

    await pressWithMouse(HOUSE_A, LONG_PRESS_MS + 400);

    expect(layer.onLongPressHouse).not.toHaveBeenCalled();
  });

  it('moves the selection from one building to the next', async () => {
    const layer = mountLayer();

    await pressWithMouse(HOUSE_A);
    await pressWithMouse(HOUSE_B);

    expect(layer.onSelectHouse.mock.calls).toEqual([['a'], ['b']]);
  });

  /* Closing the card selects nothing; the same house has to be reachable
   * again straight afterwards. */
  it('selects the same building again after it has been deselected', async () => {
    const layer = mountLayer();

    await pressWithMouse(HOUSE_A);
    await clickOpenGround();
    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse.mock.calls).toEqual([['a'], [null], ['a']]);
  });

  it('clears the selection when open ground is clicked', async () => {
    const layer = mountLayer();

    await clickOpenGround();

    expect(layer.onSelectHouse).toHaveBeenCalledWith(null);
  });

  it('ignores a building the filters have excluded', async () => {
    const layer = mountLayer({ matchedIds: new Set(['b']) });

    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse).not.toHaveBeenCalledWith('a');
  });
});

describe('tapping a building', () => {
  it('selects the one under the finger', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });

  /*
   * The reported bug on a phone, and the reason the map looked dead there.
   *
   * Leaflet hit-tests a canvas on mouse events, which a touchscreen only
   * produces for a tap the browser considers fast — Firefox gives up at around
   * 250 ms. A thumb aimed at a building a few pixels across is slower than
   * that, so the tap raised no `click`, nothing was hit-tested, and the card
   * never opened. The gesture has to answer for itself.
   */
  it('selects it when the browser sends no compatibility click at all', async () => {
    for (const holdMs of [60, 300, LONG_PRESS_MS - 50]) {
      const layer = mountLayer();

      await pressWithFinger(HOUSE_A, holdMs, { compatibilityEvents: false });

      expect(layer.onSelectHouse, `held for ${holdMs}ms`).toHaveBeenCalledWith('a');

      cleanup();
      map.remove();
      map = null;
    }
  });

  /* And the same for the tap that clears a selection. */
  it('clears the selection on a tap on open ground, with no click either', async () => {
    const layer = mountLayer();

    await tapOpenGround();

    expect(layer.onSelectHouse).toHaveBeenCalledWith(null);
  });

  /* The compatibility click, when it does arrive, must not answer twice. */
  it('answers a tap once, however many events the browser sends', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, 60, { compatibilityEvents: true });

    expect(layer.onSelectHouse.mock.calls).toEqual([['a']]);
  });

  it('selects one building after another by touch alone', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, 300, { compatibilityEvents: false });
    await pressWithFinger(HOUSE_B, 300, { compatibilityEvents: false });

    expect(layer.onSelectHouse.mock.calls).toEqual([['a'], ['b']]);
  });

  /* Two fingers are a pinch. Neither of them coming up may select anything. */
  it('selects nothing when a second finger joins the gesture', async () => {
    const layer = mountLayer();
    const { x, y } = pointOf(HOUSE_A);

    await act(async () => {
      dispatch('pointerdown', { x, y, pointerType: 'touch', pointerId: 1 });
      dispatch('pointerdown', { x: x + 40, y, pointerType: 'touch', pointerId: 2 });
      vi.advanceTimersByTime(120);
      dispatch('pointerup', { x, y, pointerType: 'touch', pointerId: 1 });
      dispatch('pointerup', { x: x + 40, y, pointerType: 'touch', pointerId: 2 });
    });

    expect(layer.onSelectHouse).not.toHaveBeenCalled();
    expect(layer.onLongPressHouse).not.toHaveBeenCalled();
  });

  /* A gesture the browser takes away — a system swipe, a notification — is not
   * a tap on anything. */
  it('selects nothing when the pointer is cancelled', async () => {
    const layer = mountLayer();
    const { x, y } = pointOf(HOUSE_A);
    const at = { x, y, pointerType: 'touch', pointerId: 7 };

    await act(async () => {
      dispatch('pointerdown', at);
      vi.advanceTimersByTime(120);
      dispatch('pointercancel', at);
      dispatch('pointerup', at);
    });

    expect(layer.onSelectHouse).not.toHaveBeenCalled();
  });

  /* A pan that starts on a building is a pan. */
  it('selects nothing when the finger travels before lifting', async () => {
    const layer = mountLayer();
    const { x, y } = pointOf(HOUSE_A);
    const at = { x, y, pointerType: 'touch', pointerId: 7 };

    await act(async () => {
      dispatch('pointerdown', at);
      vi.advanceTimersByTime(80);
      dispatch('pointermove', { ...at, x: x + 80, y: y + 50 });
      dispatch('pointerup', { ...at, x: x + 80, y: y + 50 });
    });

    expect(layer.onSelectHouse).not.toHaveBeenCalled();
  });

  /*
   * The preview exists because a touchscreen has no hover. It was armed from
   * `mousedown`, which a touchscreen only raises when the finger comes off —
   * so on the devices it was built for it never fired at all.
   */
  it('shows the preview while the finger is still down', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, LONG_PRESS_MS + 50, { liftOff: false });

    expect(layer.onLongPressHouse).toHaveBeenCalledWith('a');
    // The card is not opened as well — that is what the preview is instead of.
    expect(layer.onSelectHouse).not.toHaveBeenCalled();
  });

  it('leaves a quick tap alone', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, LONG_PRESS_MS - 100);

    expect(layer.onLongPressHouse).not.toHaveBeenCalled();
    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });

  /* The other half of the reported bug: the flag that swallows the click at the
   * end of a long press was never tied to that gesture, so it went on to eat
   * whatever came next. */
  it('lets the next tap select, after a long press', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, LONG_PRESS_MS + 100);

    expect(layer.onLongPressHouse).toHaveBeenCalledWith('a');
    expect(layer.onSelectHouse).not.toHaveBeenCalled();

    await pressWithFinger(HOUSE_B);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('b');
  });

  /* A long press whose click lands on open ground used to leave the flag set,
   * and the building tapped after that was the one that paid for it. */
  it('lets a tap select after a long press that ended off a building', async () => {
    const layer = mountLayer();

    await pressWithFinger(HOUSE_A, LONG_PRESS_MS + 100);
    await clickOpenGround();
    await pressWithFinger(HOUSE_B);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('b');
  });

  /* A press that turns into a pan is a pan. */
  it('does not fire a long press when the finger travels', async () => {
    const layer = mountLayer();
    const { x, y } = pointOf(HOUSE_A);
    const at = { x, y, pointerType: 'touch', pointerId: 7 };

    await act(async () => {
      dispatch('pointerdown', at);
      vi.advanceTimersByTime(100);
      dispatch('pointermove', { ...at, x: x + 60, y: y + 40 });
      vi.advanceTimersByTime(LONG_PRESS_MS + 100);
      dispatch('pointerup', { ...at, x: x + 60, y: y + 40 });
    });

    expect(layer.onLongPressHouse).not.toHaveBeenCalled();
  });
});

/*
 * The second half of the reported bug, and the half a mouse feels.
 *
 * Leaflet gives a polygon half its stroke width of slack when a mouse aims at
 * it — under a pixel. The map opens on the whole district, where a house is
 * three or four pixels across, so a cursor a hair off the outline hit nothing:
 * no highlight, no pointer cursor, and a click that cleared the selection
 * instead of opening the card. The renderer is given a real tolerance now, and
 * these press exactly at the edge of it.
 */
describe('aiming at a building with a mouse', () => {
  /** A point `offset` pixels east of the middle of a house's east wall. */
  function justOutside(house, offset) {
    const east = Math.max(...house.footprint.map((point) => point.lon));
    const at = map.latLngToContainerPoint([house.location.lat, east]);

    return { x: at.x + offset, y: at.y };
  }

  async function clickAt({ x, y }) {
    const at = { x, y, pointerType: 'mouse' };

    await act(async () => {
      dispatch('pointerdown', at);
      dispatch('mousedown', at);
      dispatch('pointerup', at);
      dispatch('mouseup', at);
      dispatch('click', at);
    });
  }

  it('selects the building the cursor was a few pixels short of', async () => {
    const layer = mountLayer();

    await clickAt(justOutside(HOUSE_A, 4));

    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });

  /* The slack is for aiming, not for guessing: open ground a long way from any
   * building still means "close the card". */
  it('clears the selection well outside a building', async () => {
    const layer = mountLayer();

    await clickAt(justOutside(HOUSE_A, 60));

    expect(layer.onSelectHouse).toHaveBeenCalledWith(null);
  });
});

/*
 * Hovering, and the move Leaflet throws away.
 *
 * Its canvas hit test is throttled to 32 ms with no trailing run, so a move
 * arriving inside that window is dropped outright — and the dropped one is
 * very often the last, the one that brought the cursor to rest on a building.
 * The building then stayed unlit and the cursor stayed the map's grab hand
 * until the mouse was jiggled.
 */
describe('coming to rest on a building', () => {
  async function moveTo(point) {
    await act(async () => {
      dispatch('mousemove', { ...point, pointerType: 'mouse' });
    });
  }

  it('highlights it even when Leaflet drops the move that arrived there', async () => {
    const onHoverHouse = vi.fn();

    mountLayer({ onHoverHouse });

    // The first move is hit-tested and starts Leaflet's throttle; the second,
    // the one that lands on the building, is swallowed by it.
    await moveTo({ x: 4, y: 4 });
    await moveTo(pointOf(HOUSE_A));

    expect(onHoverHouse).not.toHaveBeenCalledWith('a', expect.anything());

    // Nothing more happens: the cursor is simply resting on the house.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(onHoverHouse).toHaveBeenCalledWith('a', expect.anything());
  });

  it('reports the building the cursor actually stopped on', async () => {
    const onHoverHouse = vi.fn();

    mountLayer({ onHoverHouse });

    await moveTo(pointOf(HOUSE_A));
    await moveTo(pointOf(HOUSE_B));

    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(onHoverHouse).toHaveBeenLastCalledWith('b', expect.anything());
  });
});

/*
 * A house with no outline: typed in by hand, or imported from a list rather
 * than from OSM. It used to become a polygon with no points — invisible,
 * unhittable, and counted among the layers all the same, so asking the map to
 * show it flew the view at an empty rectangle off the coast of Africa.
 */
describe('a house the dataset has no footprint for', () => {
  const SHAPELESS = { ...makeHouse('c'), footprint: [] };
  const UNMAPPED = { ...makeHouse('d'), footprint: undefined };

  it('is left off the map rather than added as an invisible one', async () => {
    const layer = mountLayer({ houses: [HOUSE_A, SHAPELESS, UNMAPPED] });

    expect(layer.api.getHouseBounds('c')).toBeNull();
    expect(layer.api.getHouseBounds('d')).toBeNull();
    expect(layer.api.getHouseBounds('a')).not.toBeNull();
  });

  it('leaves the buildings around it selectable', async () => {
    const layer = mountLayer({ houses: [SHAPELESS, HOUSE_A] });

    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });
});

describe('while the working-area boundary is being traced', () => {
  it('selects nothing, and selects again once the editor is closed', async () => {
    const layer = mountLayer({ isSelectionEnabled: false });

    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse).not.toHaveBeenCalled();

    layer.rerender({ isSelectionEnabled: true });

    await pressWithMouse(HOUSE_A);

    expect(layer.onSelectHouse).toHaveBeenCalledWith('a');
  });

  it('shows no long-press preview either', async () => {
    const layer = mountLayer({ isSelectionEnabled: false });

    await pressWithFinger(HOUSE_A, LONG_PRESS_MS + 100, { liftOff: false });

    expect(layer.onLongPressHouse).not.toHaveBeenCalled();
  });
});

describe('finding the building under a point', () => {
  const always = () => true;

  it('answers with the building whose footprint covers it', () => {
    expect(findHouseAt(HOUSE_A.location, [HOUSE_A, HOUSE_B], always)).toBe('a');
    expect(findHouseAt(HOUSE_B.location, [HOUSE_A, HOUSE_B], always)).toBe('b');
  });

  it('answers with nothing for open ground', () => {
    expect(findHouseAt({ lat: CENTER.lat + 0.01, lon: CENTER.lon }, [HOUSE_A], always)).toBeNull();
  });

  it('skips buildings that are not selectable', () => {
    expect(findHouseAt(HOUSE_A.location, [HOUSE_A], (id) => id !== 'a')).toBeNull();
  });

  it('survives a house with no footprint', () => {
    const broken = { ...makeHouse('c'), footprint: [] };

    expect(findHouseAt(HOUSE_A.location, [broken, HOUSE_A], always)).toBe('a');
  });

  /* The user's own words for the bug were "a press on the outline of a house".
   * A footprint's outline is drawn a couple of pixels wide and a finger is far
   * wider than that, so a tap on the edge — or a hair outside it — is a tap on
   * the building. Leaflet counts the stroke as part of the shape for a mouse
   * for the same reason. */
  it('answers with the building a point just outside it was aimed at', () => {
    const edge = { lat: HOUSE_A.location.lat, lon: HOUSE_A.location.lon + 0.00035 };
    const slack = { lat: 0.0001, lon: 0.0001 };

    expect(findHouseAt(edge, [HOUSE_A, HOUSE_B], always)).toBeNull();
    expect(findHouseAt(edge, [HOUSE_A, HOUSE_B], always, slack)).toBe('a');
  });

  /* Slack decides between misses only; it can never take a tap away from the
   * building it actually landed on. */
  it('still prefers the building the point is inside', () => {
    const slack = { lat: 0.01, lon: 0.01 };

    expect(findHouseAt(HOUSE_B.location, [HOUSE_A, HOUSE_B], always, slack)).toBe('b');
    expect(findHouseAt(HOUSE_A.location, [HOUSE_B, HOUSE_A], always, slack)).toBe('a');
  });

  it('picks the nearer of two buildings a point missed', () => {
    const nearA = { lat: HOUSE_A.location.lat, lon: HOUSE_A.location.lon + 0.0004 };
    const slack = { lat: 0.002, lon: 0.002 };

    expect(findHouseAt(nearA, [HOUSE_B, HOUSE_A], always, slack)).toBe('a');
  });

  it('answers with nothing for ground beyond the slack', () => {
    expect(
      findHouseAt({ lat: CENTER.lat + 0.01, lon: CENTER.lon }, [HOUSE_A], always, {
        lat: 0.0001,
        lon: 0.0001,
      }),
    ).toBeNull();
  });
});
