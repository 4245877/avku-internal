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

import { getFillStatus } from './houseUtils.js';

/** Zoom at which house numbers are worth drawing on top of the building. */
const HOUSE_NUMBER_ZOOM = 18;
/** Upper bound on labels drawn at once, so a wide view cannot flood the map. */
const MAX_HOUSE_NUMBER_LABELS = 200;
/** Extra canvas around the viewport, as a share of it — fewer redraws on pan. */
const CANVAS_PADDING = 0.2;

/**
 * The map palette lives in CSS custom properties so light and dark themes stay
 * in one place — but a canvas renderer needs concrete colours, so they are read
 * back from the map container.
 */
function readPalette(element) {
  const computed = getComputedStyle(element);
  const read = (name, fallback) => computed.getPropertyValue(name).trim() || fallback;

  return {
    complete: {
      fill: read('--house-complete-fill', '#b6e1cf'),
      line: read('--house-complete-line', '#34926c'),
    },
    partial: {
      fill: read('--house-partial-fill', '#f6ddb4'),
      line: read('--house-partial-line', '#c9862a'),
    },
    empty: {
      fill: read('--house-empty-fill', '#cfdeeb'),
      line: read('--house-empty-line', '#93aec3'),
    },
    hover: read('--house-hover-line', '#2c5f8a'),
    selected: read('--house-selected-line', '#2c5f8a'),
    headquarters: read('--house-hq-line', '#a63e4c'),
  };
}

/**
 * Over an orthophoto the outlines have to stay legible without hiding the roofs
 * underneath — the whole point of switching to imagery is to look at them.
 */
const IMAGERY_FILL_SCALE = 0.35;

function styleFor(state, palette, fillScale = 1) {
  const tone = palette[state.status] ?? palette.empty;
  const fill = (opacity) => Math.min(1, opacity * fillScale);

  // Filtered-out buildings stay on the map as context, but faint enough that
  // the matching ones read as the answer to the query.
  if (!state.isMatched) {
    return {
      color: tone.line,
      weight: 0.5,
      opacity: 0.3,
      fillColor: tone.fill,
      fillOpacity: fill(0.2),
    };
  }

  if (state.isSelected) {
    return {
      color: palette.selected,
      weight: 3,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.95),
    };
  }

  if (state.isHovered) {
    return {
      color: palette.hover,
      weight: 2,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.95),
    };
  }

  if (state.isHeadquarters) {
    return {
      color: palette.headquarters,
      weight: 2.5,
      opacity: 1,
      fillColor: tone.fill,
      fillOpacity: fill(0.9),
    };
  }

  return {
    color: tone.line,
    weight: 1,
    opacity: 0.9,
    fillColor: tone.fill,
    fillOpacity: fill(0.82),
  };
}

const styleKeyOf = (state, fillScale) =>
  [
    state.status,
    state.isMatched ? 'm' : '',
    state.isSelected ? 's' : '',
    state.isHovered ? 'h' : '',
    state.isHeadquarters ? 'q' : '',
    fillScale,
  ].join('');

export function useHouseLayer({
  map,
  houses,
  matchedIds,
  selectedHouseId,
  hoveredHouseId,
  onSelectHouse,
  onHoverHouse,
  isImageryBasemap = false,
  isSelectionEnabled = true,
}) {
  const layersRef = useRef(new Map());
  const groupRef = useRef(null);
  const labelsRef = useRef(null);
  const rendererRef = useRef(null);
  const paletteRef = useRef(null);
  /** Bumped when the theme changes, to force a full restyle. */
  const [paletteVersion, setPaletteVersion] = useState(0);

  /* Page-level handlers are recreated every render; the map must not be. */
  const callbacksRef = useRef({ onSelectHouse, onHoverHouse });
  callbacksRef.current = { onSelectHouse, onHoverHouse };

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

    // `bubblingMouseEvents: false` on the polygons stops a building click from
    // also reaching the map, so this only fires on roads, yards and open ground.
    const clearSelection = () => {
      if (isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(null);
      }
    };

    group.on('click', (event) => {
      if (isSelectionEnabledRef.current) {
        callbacksRef.current.onSelectHouse(event.layer?.options?.houseId ?? null);
      }
    });
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

    return () => {
      map.off('click', clearSelection);
      group.remove();
      labels.remove();
      layersRef.current.clear();
      groupRef.current = null;
      labelsRef.current = null;
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
            {
              status: getFillStatus(house),
              isMatched: true,
              isSelected: false,
              isHovered: false,
              isHeadquarters: house.isHeadquarters,
            },
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
      const state = {
        status: getFillStatus(house),
        isMatched,
        isSelected: id === selectedHouseId,
        isHovered: id === hoveredHouseId,
        isHeadquarters: house.isHeadquarters,
      };

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

  /** Bounds of one building, for "show this house" from the list or search. */
  const getHouseBounds = useCallback(
    (houseId) => layersRef.current.get(houseId)?.getBounds() ?? null,
    [],
  );

  return { getHouseBounds };
}
