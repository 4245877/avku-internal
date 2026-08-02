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
 *   • pointer events are bound to the containing `FeatureGroup`, not per layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';

import { campaignStateOf, getHouseFlags } from './houseUtils.js';

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
 * "open this". Long enough not to fire while panning, short enough that nobody
 * assumes the tap was missed.
 */
const LONG_PRESS_MS = 450;

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
  // Data nobody has confirmed for months is shown faded rather than recoloured:
  // "we are not sure about this" is not a stage of work.
  const staleScale = state.isStale ? 0.55 : 1;
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

  return {
    color: state.isUrgent ? palette.urgent : tone.line,
    weight: state.isUrgent ? 2.5 : 1,
    opacity: 0.9,
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

  /** Pending long press: the timer, and the house the finger went down on. */
  const longPressRef = useRef({ timeoutId: null, houseId: null, didFire: false });

  /* Read inside the delegated handlers, which are bound once per map. */
  const isSelectionEnabledRef = useRef(isSelectionEnabled);
  isSelectionEnabledRef.current = isSelectionEnabled;

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
    rendererRef.current = L.canvas({ padding: CANVAS_PADDING });

    const group = L.featureGroup().addTo(map);
    const labels = L.layerGroup().addTo(map);
    // Badges sit in their own group so they can be cleared and redrawn on pan
    // without touching the building outlines, which are the expensive part.
    const badges = L.layerGroup().addTo(map);

    // `bubblingMouseEvents: false` on the polygons stops a building click from
    // also reaching the map, so this only fires on roads, yards and open ground.
    const clearSelection = () => {
      if (isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(null);
      }
    };

    group.on('click', (event) => {
      // A click that follows a long press is the finger lifting off the gesture
      // that already answered — opening the card as well would defeat it.
      if (longPressRef.current.didFire) {
        longPressRef.current.didFire = false;
        return;
      }

      if (isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(event.layer?.options?.houseId ?? null);
      }
    });

    /*
     * Long press → the same preview a desktop gets on hover.
     *
     * Touch devices never fire `mouseover`, so a phone had no way to see what a
     * building was without committing to opening its card. The timer is armed on
     * `mousedown` (Leaflet raises it for touch too) and disarmed by anything
     * that means the user is doing something else — lifting off, panning, or
     * pinching.
     */
    const cancelLongPress = () => {
      if (longPressRef.current.timeoutId) {
        clearTimeout(longPressRef.current.timeoutId);
        longPressRef.current.timeoutId = null;
      }
    };

    group.on('mousedown', (event) => {
      const houseId = event.layer?.options?.houseId ?? null;

      if (!houseId || !isSelectionEnabledRef.current) {
        return;
      }

      cancelLongPress();
      longPressRef.current.houseId = houseId;
      longPressRef.current.timeoutId = setTimeout(() => {
        longPressRef.current.didFire = true;
        longPressRef.current.timeoutId = null;
        callbacksRef.current.onLongPressHouse?.(houseId);
      }, LONG_PRESS_MS);
    });

    group.on('mouseup', cancelLongPress);
    map.on('movestart zoomstart', cancelLongPress);
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
      cancelLongPress();
      map.off('movestart zoomstart', cancelLongPress);
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
      present.add(house.id);

      if (layers.has(house.id)) {
        continue;
      }

      const polygon = L.polygon(
        house.footprint.map((point) => [point.lat, point.lon]),
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

  /** Bounds of one building, for "show this house" from the list or search. */
  const getHouseBounds = useCallback(
    (houseId) => layersRef.current.get(houseId)?.getBounds() ?? null,
    [],
  );

  return { getHouseBounds };
}
