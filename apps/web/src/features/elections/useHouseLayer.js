/**
 * Puts every real building on the Leaflet map as its own interactive polygon.
 *
 * One `L.Polygon` per house — that is what makes a single building clickable —
 * drawn through one shared canvas renderer, which is the only way several
 * thousand outlines stay smooth while panning.
 *
 * Three rules keep it fast:
 *   • layers are created once and keyed by OSM id, because a footprint never
 *     changes; saving a survey re-styles one polygon instead of rebuilding the
 *     district;
 *   • a style is re-applied only when its computed key actually changed;
 *   • mouse events are bound to the containing `FeatureGroup`, not per layer.
 *
 * Selection runs on two paths, because one of them cannot cover both devices:
 *
 *   mouse       Leaflet's own `click`, hit-tested by the canvas renderer.
 *   touch, pen  the pointer gesture below, hit-tested here. A canvas has no
 *               shapes for a browser to aim at, so Leaflet can only listen for
 *               mouse events — and on a touchscreen those are *compatibility*
 *               events the browser sends only for a fast tap. A press held much
 *               past a quarter of a second produces none of them, so a tap on a
 *               building simply vanished. See the gesture below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';

import { isPointInBox } from './geo.js';
import { campaignStateOf, getHouseFlags } from './houseUtils.js';
import { isPointInRing, ringBox } from './polygonGeometry.js';

/** Zoom at which house numbers are worth drawing on top of the building. */
const HOUSE_NUMBER_ZOOM = 18;
/** Upper bound on labels drawn at once, so a wide view cannot flood the map. */
const MAX_HOUSE_NUMBER_LABELS = 200;
/** Extra canvas around the viewport, as a share of it — fewer redraws on pan. */
const CANVAS_PADDING = 0.2;
/** Zoom at which the small per-house warning badges become readable. */
const BADGE_ZOOM = 17;
/** Upper bound on badges drawn at once, for the same reason as the labels. */
const MAX_BADGES = 150;
/**
 * How long a finger has to stay down to mean "tell me about this" rather than
 * "open this" — the platform norm, and only ever applied to a finger or a pen.
 *
 * Exported because the tests press for exactly this long on either side of it.
 */
export const LONG_PRESS_MS = 500;
/**
 * How far the finger may drift and still count as a press. Past this the
 * gesture is a pan, and a pan that started on a building is not a question
 * about that building.
 */
const LONG_PRESS_SLOP_PIXELS = 10;
/**
 * How far outside a footprint a pointer may land and still mean that building.
 *
 * A tap is not a pixel — and neither is a mouse. The map opens on the whole
 * district, where a house is three or four pixels across; Leaflet gives a
 * polygon half its stroke width of slack for a mouse, which is *half a pixel*
 * here. Buildings therefore behaved as though they were not on the map at all:
 * nothing lit up under the cursor, the cursor stayed the map's own grab hand,
 * and a click that missed by a pixel cleared the selection instead of opening
 * a card.
 *
 * The same number is handed to the canvas renderer, which applies it to every
 * pointing device, and used by the touch hit test below — so the mouse and the
 * finger now aim at exactly the same target.
 */
const POINTER_TOLERANCE_PIXELS = 8;
/** Fewer points than this is not a shape, so there is nothing to draw or hit. */
const MIN_FOOTPRINT_POINTS = 3;
/**
 * How long after the pointer comes to rest its last position is hit-tested
 * again. Past Leaflet's own 32 ms throttle, and short enough to read as the
 * same movement rather than as a delayed reaction. See the replay below.
 */
const HOVER_REPLAY_MS = 40;
/** Marks a replayed move, so the replay can never feed itself. */
const REPLAYED_MOVE = Symbol('replayed pointer move');
/**
 * How long the compatibility click that ends a touch gesture stays suppressed.
 *
 * A backstop, not the mechanism: the suppression is cleared by the next press
 * as well, because no browser promises that click at all — and a flag left
 * standing would be paid for by somebody's next tap.
 */
const CLICK_SUPPRESSION_MS = 700;

/**
 * The map palette lives in CSS custom properties so light and dark themes stay
 * in one place — but a canvas renderer needs concrete colours, so they are read
 * back from the map container.
 *
 * One entry per **work stage**, and nothing else. The colour of a building
 * answers exactly one question — how far the work on it has got — because a
 * colour that also carried urgency, ownership and data freshness could not
 * answer any of them. Those three are drawn as separate signals below.
 */
function readPalette(element) {
  const computed = getComputedStyle(element);
  const read = (name, fallback) => computed.getPropertyValue(name).trim() || fallback;
  const stage = (id, fill, line) => ({
    fill: read(`--stage-${id}-fill`, fill),
    line: read(`--stage-${id}-line`, line),
  });

  return {
    not_started: stage('not-started', '#cfdeeb', '#93aec3'),
    contact_setup: stage('contact-setup', '#c9dcf4', '#4a7fb5'),
    in_progress: stage('in-progress', '#f6ddb4', '#c9862a'),
    revisit_needed: stage('revisit-needed', '#e6d4f2', '#8a5cb8'),
    done: stage('done', '#b6e1cf', '#34926c'),
    blocked: stage('blocked', '#f2c9cd', '#b5474f'),
    not_applicable: stage('not-applicable', '#e2e2e2', '#a8a8a8'),
    hover: read('--house-hover-line', '#2c5f8a'),
    selected: read('--house-selected-line', '#2c5f8a'),
    headquarters: read('--house-hq-line', '#a63e4c'),
    urgent: read('--house-urgent-line', '#c0392b'),
    unassigned: read('--house-unassigned-line', '#7a6ea8'),
  };
}

/**
 * Over an orthophoto the outlines have to stay legible without hiding the roofs
 * underneath — the whole point of switching to imagery is to look at them.
 */
const IMAGERY_FILL_SCALE = 0.35;

/**
 * How the four non-colour signals are drawn.
 *
 * Each uses a different visual channel, so they can all be true at once and
 * still be told apart — and none of them touches `fillColor`, which belongs to
 * the stage alone:
 *
 *   high priority        → thicker outline
 *   no responsible       → dashed outline
 *   stale / unverified   → paler fill
 *   overdue or open work → a badge in the corner (drawn separately, below)
 */
function styleFor(state, palette, fillScale = 1) {
  const tone = palette[state.stage] ?? palette.not_started;
  /*
   * Data nobody has confirmed for months is shown faded rather than recoloured:
   * "we are not sure about this" is not a stage of work.
   *
   * The fade is deliberately slight, and that is the whole of the lesson here.
   * A district that has just been imported is *entirely* unverified, so this
   * flag is true of every building on the map — at the 0.55 it used to be, the
   * one thing it reliably did was sink the whole layer into the basemap's own
   * grey buildings, until nothing on the map read as a thing you could pick.
   * A signal that is true of everything must not be the signal that decides
   * whether anything is visible.
   */
  const staleScale = state.isStale ? 0.8 : 1;
  const fill = (opacity) => Math.min(1, opacity * fillScale * staleScale);
  const dashArray = state.hasNoAssignee ? '4 3' : undefined;

  // Filtered-out buildings stay on the map as context, but faint enough that
  // the matching ones read as the answer to the query.
  if (!state.isMatched) {
    return {
      color: tone.line,
      weight: 0.5,
      opacity: 0.3,
      fillColor: tone.fill,
      fillOpacity: fill(0.2),
      dashArray: undefined,
    };
  }

  if (state.isSelected) {
    return {
      color: palette.selected,
      weight: 3,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.95),
      dashArray,
    };
  }

  if (state.isHovered) {
    return {
      color: palette.hover,
      weight: 2,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.95),
      dashArray,
    };
  }

  if (state.isHeadquarters) {
    return {
      color: palette.headquarters,
      weight: 2.5,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.9),
      dashArray,
    };
  }

  /*
   * The resting state — every building on the map, nearly all of the time.
   *
   * It is drawn on top of cartography that already draws buildings, in its own
   * grey, so an outline any lighter than this does not say "this one is mine
   * and you can pick it" — it says nothing, and the map reads as a plain street
   * map with a tint on it.
   */
  return {
    color: state.isUrgent ? palette.urgent : tone.line,
    weight: state.isUrgent ? 2.5 : 1.5,
    opacity: 1,
    fillColor: tone.fill,
    fillOpacity: fill(0.82),
    dashArray,
  };
}

const styleKeyOf = (state, fillScale) =>
  [
    state.stage,
    state.isMatched ? 'm' : '',
    state.isSelected ? 's' : '',
    state.isHovered ? 'h' : '',
    state.isHeadquarters ? 'q' : '',
    state.isUrgent ? 'u' : '',
    state.hasNoAssignee ? 'n' : '',
    state.isStale ? 'x' : '',
    fillScale,
  ].join('');

/** No slack at all — an exact point-in-footprint test. */
const NO_TOLERANCE = { lat: 0, lon: 0 };

/**
 * The building under a geographic point, or `null`.
 *
 * The touch gesture cannot borrow Leaflet's hit test the way a mouse click
 * does — see the gesture itself, below — so it looks the building up here, from
 * the same footprints the polygons are drawn from, under the same two rules the
 * polygons' `interactive` flag follows: a filtered-out building is not there,
 * and while the boundary is being traced nothing is.
 *
 * `tolerance` is how far outside a footprint still counts, as a lat/lon radius.
 * A finger is not a pixel, and the outline of a house on a phone is a couple of
 * pixels wide — Leaflet's own mouse test counts the stroke as part of the shape
 * for exactly this reason, and a tap on the outline of a building has to select
 * that building. Inside a footprint always wins outright; slack only decides
 * between buildings that were all missed, and picks the nearest.
 */
export function findHouseAt(point, houses, isSelectable, tolerance = NO_TOLERANCE) {
  let nearestId = null;
  let nearestDistance = Infinity;

  for (const house of houses) {
    const ring = house.footprint;

    // The same rule the polygons follow: no outline, nothing on the map to aim
    // at — so there is nothing here to hit either.
    if (!ring || ring.length < MIN_FOOTPRINT_POINTS || !isSelectable(house.id)) {
      continue;
    }

    // The box first: a district runs to a few thousand buildings, and all but
    // a handful are rejected by four comparisons.
    const box = ringBox(ring);

    if (
      !isPointInBox(point, {
        minLat: box.minLat - tolerance.lat,
        maxLat: box.maxLat + tolerance.lat,
        minLon: box.minLon - tolerance.lon,
        maxLon: box.maxLon + tolerance.lon,
      })
    ) {
      continue;
    }

    if (isPointInBox(point, box) && isPointInRing(point, ring)) {
      return house.id;
    }

    // Measured in units of the tolerance itself, so a tall thin slack in
    // latitude and a wide one in longitude compare on the same scale.
    const distance = Math.hypot(
      (point.lat - (box.minLat + box.maxLat) / 2) / (tolerance.lat || 1),
      (point.lon - (box.minLon + box.maxLon) / 2) / (tolerance.lon || 1),
    );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = house.id;
    }
  }

  return nearestId;
}

/** Everything the styling and the badges need, derived once per house. */
function describeHouseState(house, { isMatched, isSelected, isHovered }) {
  const flags = getHouseFlags(house);

  return {
    stage: campaignStateOf(house).stage,
    isMatched,
    isSelected,
    isHovered,
    isHeadquarters: Boolean(house.isHeadquarters),
    isUrgent: flags.isUrgent,
    hasNoAssignee: flags.hasNoAssignee,
    isStale: flags.isStale,
    needsBadge: flags.hasOverdueTasks || flags.hasOpenIssues,
    badgeTone: flags.hasOverdueTasks ? 'overdue' : 'issue',
  };
}

export function useHouseLayer({
  map,
  houses,
  matchedIds,
  selectedHouseId,
  hoveredHouseId,
  onSelectHouse,
  onHoverHouse,
  onLongPressHouse,
  isImageryBasemap = false,
  isSelectionEnabled = true,
}) {
  const layersRef = useRef(new Map());
  const groupRef = useRef(null);
  const labelsRef = useRef(null);
  const badgesRef = useRef(null);
  const rendererRef = useRef(null);
  const paletteRef = useRef(null);
  /** Bumped when the theme changes, to force a full restyle. */
  const [paletteVersion, setPaletteVersion] = useState(0);

  /* Page-level handlers are recreated every render; the map must not be. */
  const callbacksRef = useRef({ onSelectHouse, onHoverHouse, onLongPressHouse });
  callbacksRef.current = { onSelectHouse, onHoverHouse, onLongPressHouse };

  /** The touch gesture in flight: which finger, which house, where it began. */
  const pressRef = useRef({
    pointerId: null,
    houseId: null,
    origin: null,
    timeoutId: null,
    didFire: false,
  });
  /** Set by a gesture that answered itself, to drop the click ending it. */
  const suppressClickRef = useRef({ isActive: false, timeoutId: null });

  /* Read inside the delegated handlers, which are bound once per map. */
  const isSelectionEnabledRef = useRef(isSelectionEnabled);
  isSelectionEnabledRef.current = isSelectionEnabled;

  const housesRef = useRef(houses);
  housesRef.current = houses;

  const matchedIdsRef = useRef(matchedIds);
  matchedIdsRef.current = matchedIds;

  const housesById = useMemo(
    () => new Map(houses.map((house) => [house.id, house])),
    [houses],
  );

  /* The layer group and its delegated pointer handlers — created once per map. */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    paletteRef.current = readPalette(map.getContainer());
    // `tolerance` is what makes a building on this map aimable at all: the
    // renderer adds it to every polygon's hit area, for hover and for clicks,
    // whatever the pointing device. See `POINTER_TOLERANCE_PIXELS`.
    rendererRef.current = L.canvas({
      padding: CANVAS_PADDING,
      tolerance: POINTER_TOLERANCE_PIXELS,
    });

    const group = L.featureGroup().addTo(map);
    const labels = L.layerGroup().addTo(map);
    // Badges sit in their own group so they can be cleared and redrawn on pan
    // without touching the building outlines, which are the expensive part.
    const badges = L.layerGroup().addTo(map);

    /*
     * The compatibility click, and when it must be ignored.
     *
     * A touch gesture answers for itself below, on `pointerup`. Whatever the
     * browser decides to send afterwards would answer a second time, so it is
     * dropped — but *only* the one click that ends that gesture. The flag is
     * cleared when the next press starts and by a timer of its own, because no
     * browser promises a compatibility click at all: one that never arrived
     * used to leave the flag standing, and the next building somebody tapped
     * was the one that paid for it.
     */
    const clearSuppression = () => {
      clearTimeout(suppressClickRef.current.timeoutId);
      suppressClickRef.current = { isActive: false, timeoutId: null };
    };

    const suppressNextClick = () => {
      clearSuppression();
      suppressClickRef.current = {
        isActive: true,
        timeoutId: setTimeout(clearSuppression, CLICK_SUPPRESSION_MS),
      };
    };

    /** True once, for the click that ends a gesture already answered. */
    const takeSuppressedClick = () => {
      if (!suppressClickRef.current.isActive) {
        return false;
      }

      clearSuppression();

      return true;
    };

    // `bubblingMouseEvents: false` on the polygons stops a building click from
    // also reaching the map, so this only fires on roads, yards and open ground.
    const clearSelection = () => {
      if (!takeSuppressedClick() && isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(null);
      }
    };

    group.on('click', (event) => {
      if (takeSuppressedClick()) {
        return;
      }

      if (isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(event.layer?.options?.houseId ?? null);
      }
    });

    /*
     * Touch and pen: the whole gesture, handled here rather than by Leaflet.
     *
     * Leaflet's canvas renderer hit-tests on mouse events only — a canvas has no
     * shapes for the browser to aim at, so there is nothing else for it to bind
     * to. On a touchscreen those events are *compatibility* events, and a
     * browser sends them only for what it judges to be a fast tap: Firefox stops
     * at somewhere around a quarter of a second. Past that a tap produces
     * `pointerdown`, `touchstart`, `pointerup`, `touchend` and nothing else — no
     * `mousedown`, no `click`, so no hit test, so no selection. A canvasser
     * aiming a thumb at a building a few pixels across is well past that limit,
     * which is how a map full of houses came to be a map you cannot pick a house
     * off.
     *
     * So a finger selects on `pointerup`, from our own hit test, and does not
     * depend on the browser being generous. Holding past `LONG_PRESS_MS` asks
     * for the preview instead — the touch equivalent of hovering, which a
     * touchscreen cannot do.
     *
     * A mouse is deliberately left alone: Leaflet's `click` has always worked
     * for it, and it has the hover tooltip already. Reading a slow mouse press
     * as a long press is what stopped deliberate clicks opening the card.
     */
    const cancelPress = () => {
      clearTimeout(pressRef.current.timeoutId);
      pressRef.current = {
        pointerId: null,
        houseId: null,
        origin: null,
        timeoutId: null,
        didFire: false,
      };
    };

    const container = map.getContainer();

    const onPointerDown = (event) => {
      // Whatever the previous gesture was still holding open, it is over.
      clearSuppression();

      // A second finger is a pinch, not a tap: it ends the gesture rather than
      // starting one, and neither finger coming up may select anything.
      const isSecondFinger = pressRef.current.pointerId !== null;

      cancelPress();

      if (
        isSecondFinger ||
        event.pointerType === 'mouse' ||
        !isSelectionEnabledRef.current ||
        event.target?.closest?.('.leaflet-control')
      ) {
        return;
      }

      const origin = map.mouseEventToContainerPoint(event);
      const { lat, lng } = map.containerPointToLatLng(origin);
      // The finger's slack, in degrees at this zoom — the projection changes
      // with both, so it is measured rather than assumed.
      const slack = map.containerPointToLatLng([
        origin.x + POINTER_TOLERANCE_PIXELS,
        origin.y + POINTER_TOLERANCE_PIXELS,
      ]);
      // `null` over open ground — the gesture is still recorded, because
      // tapping open ground is how a selection is cleared.
      const houseId = findHouseAt(
        { lat, lon: lng },
        housesRef.current,
        (id) => matchedIdsRef.current.has(id),
        { lat: Math.abs(slack.lat - lat), lon: Math.abs(slack.lng - lng) },
      );

      pressRef.current = {
        pointerId: event.pointerId,
        houseId,
        origin,
        didFire: false,
        timeoutId: houseId
          ? setTimeout(() => {
              pressRef.current.timeoutId = null;
              pressRef.current.didFire = true;
              callbacksRef.current.onLongPressHouse?.(houseId);
            }, LONG_PRESS_MS)
          : null,
      };
    };

    const isSamePointer = (event) =>
      pressRef.current.pointerId !== null && event.pointerId === pressRef.current.pointerId;

    const onPointerMove = (event) => {
      if (!isSamePointer(event) || pressRef.current.didFire) {
        return;
      }

      // Past the slop the gesture is a pan, and a pan that began on a building
      // is not a question about that building.
      if (
        map.mouseEventToContainerPoint(event).distanceTo(pressRef.current.origin) >
        LONG_PRESS_SLOP_PIXELS
      ) {
        cancelPress();
      }
    };

    // Bound on the window: a finger that slides off the map still ends the
    // gesture, and a pointer captured elsewhere would never report back here.
    const onPointerUp = (event) => {
      if (!isSamePointer(event)) {
        return;
      }

      const { houseId, didFire } = pressRef.current;

      cancelPress();

      if (!isSelectionEnabledRef.current) {
        return;
      }

      // This gesture has answered. Whatever compatibility click the browser
      // decides to send afterwards must not answer it a second time.
      suppressNextClick();

      // A press that showed the preview has said its piece; opening the card as
      // well would defeat the gesture.
      if (!didFire) {
        callbacksRef.current.onSelectHouse(houseId);
      }
    };

    /** A cancelled pointer selected nothing — it stopped being a gesture. */
    const onPointerCancel = () => cancelPress();

    /*
     * The move Leaflet always throws away, played back.
     *
     * Its canvas hit test is throttled to 32 ms and has no trailing run: a move
     * that arrives inside the window is dropped outright, and the one that
     * arrives inside the window is very often the *last* one — the move that
     * brought the pointer to rest on a building. So the building under the
     * cursor stayed unlit and the cursor stayed the map's grab hand until the
     * mouse was jiggled, which is what "the houses do not highlight" looks like
     * from a chair.
     *
     * Replaying the final position once the window has passed is the whole of
     * the fix. Only genuine moves are replayed, so a replay cannot feed itself,
     * and the event is dispatched on the element that received the original —
     * the renderer's canvas, which is the only thing that hit-tests.
     */
    let replayTimeoutId = null;

    const cancelReplay = () => clearTimeout(replayTimeoutId);

    const onMouseMove = (event) => {
      if (event[REPLAYED_MOVE]) {
        return;
      }

      const { clientX, clientY, target } = event;

      cancelReplay();
      replayTimeoutId = setTimeout(() => {
        const replay = new MouseEvent('mousemove', { bubbles: true, clientX, clientY });

        replay[REPLAYED_MOVE] = true;
        target.dispatchEvent(replay);
      }, HOVER_REPLAY_MS);
    };

    container.addEventListener('pointerdown', onPointerDown, { passive: true });
    container.addEventListener('pointermove', onPointerMove, { passive: true });
    container.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    map.on('movestart zoomstart', cancelPress);
    // A moving map re-tests everything by itself; a replay landing mid-flight
    // would only be asking about ground that has already gone past.
    map.on('movestart zoomstart', cancelReplay);

    // The pointer position travels with the event, so the tooltip can appear on
    // the same frame the building is entered instead of on the next move.
    group.on('mouseover', (event) =>
      callbacksRef.current.onHoverHouse(
        event.layer?.options?.houseId ?? null,
        event.containerPoint,
      ),
    );
    group.on('mouseout', () => callbacksRef.current.onHoverHouse(null, null));
    map.on('click', clearSelection);

    groupRef.current = group;
    labelsRef.current = labels;
    badgesRef.current = badges;

    return () => {
      cancelPress();
      cancelReplay();
      clearSuppression();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      map.off('movestart zoomstart', cancelPress);
      map.off('movestart zoomstart', cancelReplay);
      map.off('click', clearSelection);
      group.remove();
      labels.remove();
      badges.remove();
      layersRef.current.clear();
      groupRef.current = null;
      labelsRef.current = null;
      badgesRef.current = null;
      rendererRef.current = null;
    };
  }, [map]);

  /* Theme switches change every colour on the map at once. */
  useEffect(() => {
    if (!map) {
      return undefined;
    }

    const refresh = () => {
      paletteRef.current = readPalette(map.getContainer());

      for (const layer of layersRef.current.values()) {
        layer.options.styleKey = null;
      }

      setPaletteVersion((current) => current + 1);
    };

    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refresh);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', refresh);
    };
  }, [map]);

  /* Building outlines: created once per house, never re-projected afterwards. */
  useEffect(() => {
    const group = groupRef.current;

    if (!map || !group) {
      return;
    }

    const renderer = rendererRef.current;
    const layers = layersRef.current;
    const present = new Set();

    for (const house of houses) {
      const ring = house.footprint ?? [];

      /*
       * A house the dataset has no outline for — one typed in by hand, or
       * imported from a list rather than from OSM — used to become a polygon
       * with no points: invisible, unhittable, and counted among the layers all
       * the same, so "show this house" from the list flew the map at nothing.
       * It has no place on the map until somebody draws it; the list and the
       * card are where it is worked on.
       */
      if (ring.length < MIN_FOOTPRINT_POINTS) {
        continue;
      }

      present.add(house.id);

      if (layers.has(house.id)) {
        continue;
      }

      const polygon = L.polygon(
        ring.map((point) => [point.lat, point.lon]),
        {
          houseId: house.id,
          renderer,
          interactive: true,
          bubblingMouseEvents: false,
          ...styleFor(
            describeHouseState(house, {
              isMatched: true,
              isSelected: false,
              isHovered: false,
            }),
            paletteRef.current,
          ),
        },
      );

      layers.set(house.id, polygon);
      group.addLayer(polygon);
    }

    for (const [id, layer] of layers) {
      if (!present.has(id)) {
        group.removeLayer(layer);
        layers.delete(id);
      }
    }
  }, [houses, map]);

  /* Styling: survey status, filter match, selection and hover. */
  useEffect(() => {
    if (!map || !groupRef.current) {
      return;
    }

    const palette = paletteRef.current ?? readPalette(map.getContainer());
    const fillScale = isImageryBasemap ? IMAGERY_FILL_SCALE : 1;

    for (const [id, layer] of layersRef.current) {
      const house = housesById.get(id);

      if (!house) {
        continue;
      }

      const isMatched = matchedIds.has(id);
      const state = describeHouseState(house, {
        isMatched,
        isSelected: id === selectedHouseId,
        isHovered: id === hoveredHouseId,
      });

      // Faded buildings stop swallowing clicks aimed at the ones that match,
      // and while the boundary is being traced nothing takes clicks at all.
      layer.options.interactive = isMatched && isSelectionEnabled;

      const key = styleKeyOf(state, fillScale);

      if (layer.options.styleKey === key) {
        continue;
      }

      layer.options.styleKey = key;
      layer.setStyle(styleFor(state, palette, fillScale));

      if (state.isSelected || state.isHovered) {
        layer.bringToFront();
      }
    }
  }, [
    hoveredHouseId,
    housesById,
    isImageryBasemap,
    isSelectionEnabled,
    map,
    matchedIds,
    paletteVersion,
    selectedHouseId,
  ]);

  /* House numbers, close up only, and only for what is actually on screen. */
  useEffect(() => {
    const labels = labelsRef.current;

    if (!map || !labels) {
      return undefined;
    }

    const render = () => {
      labels.clearLayers();

      if (map.getZoom() < HOUSE_NUMBER_ZOOM) {
        return;
      }

      const viewport = map.getBounds();
      let drawn = 0;

      for (const house of houses) {
        if (drawn >= MAX_HOUSE_NUMBER_LABELS) {
          break;
        }

        const position = [house.location.lat, house.location.lon];

        if (!matchedIds.has(house.id) || !viewport.contains(position)) {
          continue;
        }

        labels.addLayer(
          L.marker(position, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'elections-house-number',
              html: `<span>${house.number}</span>`,
              iconSize: [0, 0],
            }),
          }),
        );

        drawn += 1;
      }
    };

    render();
    map.on('moveend zoomend', render);

    return () => {
      map.off('moveend zoomend', render);
    };
  }, [houses, map, matchedIds]);

  /*
   * Warning badges: overdue tasks and open issues.
   *
   * A separate mark rather than a colour, because a house can be "done" and
   * still have an unresolved complaint on it — the two facts do not compete for
   * the same pixel. Drawn only close up and only for what is on screen, the same
   * budget the house numbers use.
   */
  useEffect(() => {
    const badges = badgesRef.current;

    if (!map || !badges) {
      return undefined;
    }

    const render = () => {
      badges.clearLayers();

      if (map.getZoom() < BADGE_ZOOM) {
        return;
      }

      const viewport = map.getBounds();
      let drawn = 0;

      for (const house of houses) {
        if (drawn >= MAX_BADGES) {
          break;
        }

        if (!matchedIds.has(house.id)) {
          continue;
        }

        const flags = getHouseFlags(house);

        if (!flags.hasOverdueTasks && !flags.hasOpenIssues) {
          continue;
        }

        const position = [house.location.lat, house.location.lon];

        if (!viewport.contains(position)) {
          continue;
        }

        const state = campaignStateOf(house);
        const isOverdue = flags.hasOverdueTasks;
        const title = isOverdue
          ? `Прострочених задач: ${state.overdueTasksCount}`
          : `Відкритих звернень: ${state.openIssuesCount}`;

        badges.addLayer(
          L.marker(position, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'elections-house-badge',
              html: `<span data-tone="${isOverdue ? 'overdue' : 'issue'}" title="${title}"></span>`,
              iconSize: [0, 0],
            }),
          }),
        );

        drawn += 1;
      }
    };

    render();
    map.on('moveend zoomend', render);

    return () => {
      map.off('moveend zoomend', render);
    };
  }, [houses, map, matchedIds]);

  /**
   * Bounds of one building, for "show this house" from the list or search.
   *
   * `null` for anything the map cannot show, so the caller keeps the view it
   * has rather than flying to an empty rectangle off the coast of Africa.
   */
  const getHouseBounds = useCallback((houseId) => {
    const bounds = layersRef.current.get(houseId)?.getBounds();

    return bounds?.isValid() ? bounds : null;
  }, []);

  return { getHouseBounds };
}
