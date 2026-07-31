/**
 * Boundary editing for the working area.
 *
 * The border is traced directly over the live map — click to drop a vertex,
 * drag a vertex to move it, drag the hollow midpoint handle to add one between
 * two neighbours, right-click to remove one. Saving puts the outline in force
 * straight away (see the store in `workspaceArea.js`); the same outline can
 * also be exported as the exact `workspaceArea.geo.json` document the app ships
 * with, which is how a boundary becomes permanent for everybody.
 *
 * The mode is opened from the page's «Редагувати межу» button and mirrored into
 * the URL as `?areaEdit=1`, so it can be linked to and left by reloading. The
 * unsaved outline is kept in `localStorage` so that a reload in the middle of
 * tracing a district does not throw the work away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';

import { ringAreaSquareMeters } from './geo.js';
import { isRingSelfIntersecting } from './polygonGeometry.js';
import { useWorkspaceArea } from './useWorkspaceArea.js';
import {
  SHIPPED_WORKSPACE_AREA,
  getWorkspaceArea,
  ringsAreEqual,
  saveWorkspaceArea,
  toWorkspaceFeature,
} from './workspaceArea.js';

/** Where an unfinished outline survives a page reload. */
const DRAFT_STORAGE_KEY = 'avku-elections-area-draft-v1';
/** The query parameter that mirrors the mode: `?areaEdit=1`. */
const EDIT_MODE_PARAM = 'areaEdit';
/** Undo depth — deep enough for a long trace, bounded so nothing grows forever. */
const HISTORY_LIMIT = 200;
/** File name offered by the browser; also where an export has to be saved. */
export const EXPORT_FILE_NAME = 'workspaceArea.geo.json';

function readDraft() {
  try {
    const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;

    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ lat: point.lat, lon: point.lon }));
  } catch {
    return null;
  }
}

function writeDraft(ring) {
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(ring));
  } catch {
    // Private mode: the outline still lives in memory for this session.
  }
}

function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

function isEditModeInUrl() {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return new URLSearchParams(window.location.search).get(EDIT_MODE_PARAM) === '1';
  } catch {
    return false;
  }
}

/** Writes the mode into the address bar without disturbing the router. */
function setEditModeInUrl(isActive) {
  const url = new URL(window.location.href);

  if (isActive) {
    url.searchParams.set(EDIT_MODE_PARAM, '1');
  } else {
    url.searchParams.delete(EDIT_MODE_PARAM);
  }

  window.history.replaceState(window.history.state, '', url);
}

/**
 * Whether the boundary editor is open. The mode is mirrored in the URL rather
 * than kept in component state alone, so it can be shared, bookmarked and — most
 * importantly — left by simply reloading the page.
 */
export function useAreaEditMode() {
  const [isActive, setIsActive] = useState(isEditModeInUrl);

  useEffect(() => {
    const sync = () => setIsActive(isEditModeInUrl());

    window.addEventListener('popstate', sync);

    return () => window.removeEventListener('popstate', sync);
  }, []);

  const enter = useCallback(() => {
    setEditModeInUrl(true);
    setIsActive(true);
  }, []);

  const exit = useCallback(() => {
    setEditModeInUrl(false);
    setIsActive(false);
  }, []);

  return { isActive, enter, exit };
}

const toLatLngs = (ring) => ring.map((point) => [point.lat, point.lon]);

/** Midpoint of two vertices, on the same flat approximation the ring uses. */
const midpoint = (from, to) => ({
  lat: (from.lat + to.lat) / 2,
  lon: (from.lon + to.lon) / 2,
});

function vertexIcon(className) {
  return L.divIcon({ className, html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] });
}

export function useWorkspaceEditor({ map, isActive = false }) {
  /** The territory in force — what "restore the saved boundary" means. */
  const area = useWorkspaceArea();

  /** An outline left over from an interrupted session, if there is one. */
  const [restoredDraft] = useState(readDraft);

  /** The outline being traced, as an open ring — the single source of truth. */
  const [ring, setRing] = useState(() => restoredDraft ?? getWorkspaceArea().outerRing);
  const ringRef = useRef(ring);
  const historyRef = useRef([]);
  const [historyDepth, setHistoryDepth] = useState(0);

  const layersRef = useRef(null);

  ringRef.current = ring;

  /** Every mutation goes through here, so undo and the draft stay honest. */
  const commit = useCallback((next) => {
    historyRef.current = [...historyRef.current, ringRef.current].slice(-HISTORY_LIMIT);
    setHistoryDepth(historyRef.current.length);
    ringRef.current = next;
    setRing(next);
    writeDraft(next);
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.at(-1);

    if (!previous) {
      return;
    }

    historyRef.current = historyRef.current.slice(0, -1);
    setHistoryDepth(historyRef.current.length);
    ringRef.current = previous;
    setRing(previous);
    writeDraft(previous);
  }, []);

  const clear = useCallback(() => commit([]), [commit]);

  /** Back to the boundary that is currently in force. */
  const resetToSaved = useCallback(() => commit(area.outerRing), [area, commit]);

  /** Back to the boundary the repository ships — the way out of a bad save. */
  const resetToShipped = useCallback(
    () => commit(SHIPPED_WORKSPACE_AREA.outerRing),
    [commit],
  );

  const removeLastPoint = useCallback(() => {
    if (ringRef.current.length > 0) {
      commit(ringRef.current.slice(0, -1));
    }
  }, [commit]);

  /* Drawing surface: the draft polygon plus one handle per vertex and midpoint. */
  useEffect(() => {
    if (!map || !isActive) {
      return undefined;
    }

    const renderer = L.svg({ padding: 1 });
    const shape = L.polygon([], {
      interactive: false,
      className: 'elections-area-draft',
      renderer,
    }).addTo(map);
    const handles = L.layerGroup().addTo(map);

    layersRef.current = { shape, handles };
    map.getContainer().classList.add('elections-area-editing');

    const addVertex = (event) => {
      commit([...ringRef.current, { lat: event.latlng.lat, lon: event.latlng.lng }]);
    };

    map.on('click', addVertex);

    return () => {
      map.off('click', addVertex);
      map.getContainer().classList.remove('elections-area-editing');
      shape.remove();
      handles.remove();
      layersRef.current = null;
    };
  }, [commit, isActive, map]);

  /* Handles are rebuilt from the ring — the ring is never read back off them. */
  useEffect(() => {
    const layers = layersRef.current;

    if (!map || !isActive || !layers) {
      return;
    }

    const { shape, handles } = layers;

    shape.setLatLngs(toLatLngs(ring));
    handles.clearLayers();

    ring.forEach((point, index) => {
      const vertex = L.marker([point.lat, point.lon], {
        draggable: true,
        keyboard: false,
        icon: vertexIcon('elections-area-vertex'),
        title: `Вершина ${index + 1} — перетягніть, щоб посунути, права кнопка щоб видалити`,
      });

      // Dragging repaints the outline every frame but writes state only once,
      // at the end: committing on every `drag` would rebuild all the handles
      // under the cursor and drop the gesture.
      vertex.on('drag', (event) => {
        const moved = ringRef.current.map((current, at) =>
          at === index ? { lat: event.latlng.lat, lon: event.latlng.lng } : current,
        );

        shape.setLatLngs(toLatLngs(moved));
      });

      vertex.on('dragend', (event) => {
        const { lat, lng } = event.target.getLatLng();

        commit(
          ringRef.current.map((current, at) =>
            at === index ? { lat, lon: lng } : current,
          ),
        );
      });

      vertex.on('contextmenu', (event) => {
        L.DomEvent.stop(event);
        commit(ringRef.current.filter((_, at) => at !== index));
      });

      handles.addLayer(vertex);
    });

    // Midpoints only make sense once the outline is a shape rather than a line.
    if (ring.length >= 3) {
      ring.forEach((point, index) => {
        const next = ring[(index + 1) % ring.length];
        const between = midpoint(point, next);
        const insertAt = index + 1;

        const handle = L.marker([between.lat, between.lon], {
          draggable: true,
          keyboard: false,
          icon: vertexIcon('elections-area-midpoint'),
          title: 'Перетягніть, щоб додати вершину між сусідніми',
        });

        const insert = (latlng) => [
          ...ringRef.current.slice(0, insertAt),
          { lat: latlng.lat, lon: latlng.lng },
          ...ringRef.current.slice(insertAt),
        ];

        handle.on('drag', (event) => shape.setLatLngs(toLatLngs(insert(event.latlng))));
        handle.on('dragend', (event) => commit(insert(event.target.getLatLng())));
        handle.on('click', (event) => {
          L.DomEvent.stop(event);
          commit(insert(event.target.getLatLng()));
        });

        handles.addLayer(handle);
      });
    }
  }, [commit, isActive, map, ring]);

  /* Undo and "take that point back" from the keyboard, as while drawing. */
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    const onKeyDown = (event) => {
      const target = event.target;

      if (target instanceof HTMLElement && target.closest('input, textarea, select')) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        removeLastPoint();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, removeLastPoint, undo]);

  const feature = useMemo(
    () => (ring.length >= 3 ? toWorkspaceFeature(ring) : null),
    [ring],
  );

  const geoJson = useMemo(
    () => (feature ? `${JSON.stringify(feature, null, 2)}\n` : ''),
    [feature],
  );

  /**
   * Puts the traced outline in force: the map redraws its border and mask, and
   * the dataset is re-cut to it. Nothing else has to happen for the new
   * territory to be the one the module works with — committing the exported
   * file to the repository is what makes it everybody's boundary, not this.
   */
  const save = useCallback(() => {
    if (!feature) {
      return { isSaved: false, error: 'Потрібно щонайменше 3 точки.' };
    }

    try {
      const { area: saved, isPersisted } = saveWorkspaceArea(feature);

      clearDraft();
      ringRef.current = saved.outerRing;
      setRing(saved.outerRing);

      return { isSaved: true, isPersisted };
    } catch (error) {
      return { isSaved: false, error: error?.message ?? 'Не вдалося зберегти межу.' };
    }
  }, [feature]);

  /** Offers the traced boundary as a file, ready to replace the shipped one. */
  const download = useCallback(() => {
    if (!geoJson) {
      return;
    }

    const url = URL.createObjectURL(new Blob([geoJson], { type: 'application/geo+json' }));
    const link = document.createElement('a');

    link.href = url;
    link.download = EXPORT_FILE_NAME;
    link.click();

    URL.revokeObjectURL(url);
  }, [geoJson]);

  const copy = useCallback(async () => {
    if (!geoJson) {
      return false;
    }

    try {
      await navigator.clipboard.writeText(geoJson);

      return true;
    } catch {
      return false;
    }
  }, [geoJson]);

  const hasUnsavedChanges = !ringsAreEqual(ring, area.outerRing);

  // Quadratic in the vertex count, so it is computed per outline rather than
  // per render — a hand-traced district runs to a few hundred points.
  const isSelfIntersecting = useMemo(
    () => ring.length >= 4 && isRingSelfIntersecting(ring),
    [ring],
  );

  return {
    ring,
    geoJson,
    feature,
    areaName: area.name,
    vertexCount: ring.length,
    areaSqm: ring.length >= 3 ? ringAreaSquareMeters(ring) : 0,
    /** Three points are the least that encloses ground; below that, nothing. */
    isSaveable: ring.length >= 3,
    isSelfIntersecting,
    hasUnsavedChanges,
    /** An interrupted session was picked up rather than the saved boundary. */
    hasRestoredDraft: Boolean(restoredDraft) && hasUnsavedChanges,
    isAreaCustom: area.isCustom,
    canUndo: historyDepth > 0,
    undo,
    clear,
    resetToSaved,
    resetToShipped,
    removeLastPoint,
    save,
    download,
    copy,
  };
}
