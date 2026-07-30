/**
 * Pan / zoom viewport for the SVG map.
 *
 * The map draws everything in the local metre grid; this hook owns the single
 * transform that maps metres to pixels, plus every gesture that changes it:
 * wheel, drag, pinch, buttons and keyboard.
 *
 * `viewport` = the world point at the centre of the container plus `zoom`,
 * expressed in pixels per metre.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Never let the user zoom further out than the fitted view. */
const MIN_ZOOM_FACTOR = 0.9;
/** Pixels per metre at maximum zoom — roughly "one building fills the screen". */
const MAX_ZOOM = 4.5;
const WHEEL_INTENSITY = 0.0018;
const BUTTON_ZOOM_STEP = 1.6;
const KEYBOARD_PAN_PIXELS = 110;
/** Movement above this many pixels counts as a pan, not a click. */
const DRAG_THRESHOLD_PIXELS = 4;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function useMapViewport({ worldRadius }) {
  const containerRef = useRef(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const viewportRef = useRef({ x: 0, y: 0, zoom: 0 });
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const hasPannedRef = useRef(false);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 0 });
  const [isPanning, setIsPanning] = useState(false);

  viewportRef.current = viewport;

  const fitZoom = useMemo(() => {
    if (!size.width || !size.height) {
      return 0;
    }

    // 2.16 ≈ diameter plus a small margin, so the radius ring is never clipped.
    return Math.min(size.width, size.height) / (worldRadius * 2.16);
  }, [size.height, size.width, worldRadius]);

  const fitZoomRef = useRef(fitZoom);
  fitZoomRef.current = fitZoom;

  const clampViewport = useCallback(
    (next) => {
      const minZoom = fitZoomRef.current > 0 ? fitZoomRef.current * MIN_ZOOM_FACTOR : 0;
      const limit = worldRadius * 1.15;

      return {
        x: clamp(next.x, -limit, limit),
        y: clamp(next.y, -limit, limit),
        zoom: minZoom > 0 ? clamp(next.zoom, minZoom, MAX_ZOOM) : next.zoom,
      };
    },
    [worldRadius],
  );

  useLayoutEffect(() => {
    const element = containerRef.current;

    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;

      if (!rect) {
        return;
      }

      sizeRef.current = { width: rect.width, height: rect.height };
      setSize({ width: rect.width, height: rect.height });
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // First measurement decides the initial fitted view.
  useEffect(() => {
    if (fitZoom > 0 && viewportRef.current.zoom === 0) {
      setViewport({ x: 0, y: 0, zoom: fitZoom });
    }
  }, [fitZoom]);

  const zoomBy = useCallback(
    (factor, anchorPoint) => {
      setViewport((current) => {
        if (current.zoom === 0) {
          return current;
        }

        const next = clampViewport({ ...current, zoom: current.zoom * factor });

        if (next.zoom === current.zoom) {
          return current;
        }

        const { width, height } = sizeRef.current;
        const anchor = anchorPoint ?? { x: width / 2, y: height / 2 };
        const offsetX = anchor.x - width / 2;
        const offsetY = anchor.y - height / 2;

        // Keep the world point under the anchor pinned while the scale changes.
        const worldX = current.x + offsetX / current.zoom;
        const worldY = current.y + offsetY / current.zoom;

        return clampViewport({
          zoom: next.zoom,
          x: worldX - offsetX / next.zoom,
          y: worldY - offsetY / next.zoom,
        });
      });
    },
    [clampViewport],
  );

  const panByPixels = useCallback(
    (deltaX, deltaY) => {
      setViewport((current) => {
        if (current.zoom === 0) {
          return current;
        }

        return clampViewport({
          ...current,
          x: current.x - deltaX / current.zoom,
          y: current.y - deltaY / current.zoom,
        });
      });
    },
    [clampViewport],
  );

  const zoomIn = useCallback(() => zoomBy(BUTTON_ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / BUTTON_ZOOM_STEP), [zoomBy]);

  const resetView = useCallback(() => {
    if (fitZoomRef.current > 0) {
      setViewport({ x: 0, y: 0, zoom: fitZoomRef.current });
    }
  }, []);

  /** Brings a world-space bounding box into view without ever zooming out. */
  const focusOnBounds = useCallback(
    (bounds) => {
      const { width, height } = sizeRef.current;

      if (!width || !height) {
        return;
      }

      const boundsWidth = Math.max(bounds.maxX - bounds.minX, 12);
      const boundsHeight = Math.max(bounds.maxY - bounds.minY, 12);
      // Show the house at roughly a third of the viewport, keeping the street
      // and neighbouring buildings visible for orientation.
      const targetZoom = Math.min(width / (boundsWidth * 3.2), height / (boundsHeight * 3.2));

      setViewport((current) =>
        clampViewport({
          x: (bounds.minX + bounds.maxX) / 2,
          y: (bounds.minY + bounds.maxY) / 2,
          zoom: Math.max(current.zoom, Math.min(targetZoom, MAX_ZOOM)),
        }),
      );
    },
    [clampViewport],
  );

  const endGesture = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    setIsPanning(false);
  }, []);

  // Wheel must be non-passive to cancel page scroll, which React's synthetic
  // handler cannot guarantee — so it is attached natively.
  useEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return undefined;
    }

    function handleWheel(event) {
      event.preventDefault();

      const rect = element.getBoundingClientRect();

      zoomBy(Math.exp(-event.deltaY * WHEEL_INTENSITY), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }

    element.addEventListener('wheel', handleWheel, { passive: false });

    return () => element.removeEventListener('wheel', handleWheel);
  }, [zoomBy]);

  const handlePointerDown = useCallback(
    (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }

      hasPannedRef.current = false;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointersRef.current.size === 1) {
        gestureRef.current = { mode: 'pan' };
        setIsPanning(true);
        return;
      }

      const [first, second] = [...pointersRef.current.values()];

      gestureRef.current = {
        mode: 'pinch',
        distance: Math.hypot(second.x - first.x, second.y - first.y),
      };
    },
    [],
  );

  // Drag and pinch are tracked on the window so the gesture survives the
  // pointer leaving the map (and pointer capture never steals house clicks).
  useEffect(() => {
    if (!isPanning && !gestureRef.current) {
      return undefined;
    }

    function handlePointerMove(event) {
      const pointers = pointersRef.current;
      const previous = pointers.get(event.pointerId);

      if (!previous) {
        return;
      }

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      const gesture = gestureRef.current;

      if (!gesture) {
        return;
      }

      if (gesture.mode === 'pinch' && pointers.size >= 2) {
        const [first, second] = [...pointers.values()];
        const distance = Math.hypot(second.x - first.x, second.y - first.y);

        if (gesture.distance > 0 && distance > 0) {
          const element = containerRef.current;
          const rect = element?.getBoundingClientRect();

          zoomBy(distance / gesture.distance, {
            x: (first.x + second.x) / 2 - (rect?.left ?? 0),
            y: (first.y + second.y) / 2 - (rect?.top ?? 0),
          });
        }

        gesture.distance = distance;
        hasPannedRef.current = true;

        return;
      }

      const deltaX = event.clientX - previous.x;
      const deltaY = event.clientY - previous.y;

      if (Math.abs(deltaX) > DRAG_THRESHOLD_PIXELS || Math.abs(deltaY) > DRAG_THRESHOLD_PIXELS) {
        hasPannedRef.current = true;
      }

      panByPixels(deltaX, deltaY);
    }

    function handlePointerUp(event) {
      pointersRef.current.delete(event.pointerId);

      if (pointersRef.current.size === 0) {
        endGesture();
        return;
      }

      gestureRef.current = { mode: 'pan' };
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [endGesture, isPanning, panByPixels, zoomBy]);

  const handleKeyDown = useCallback(
    (event) => {
      const panKeys = {
        ArrowUp: [0, KEYBOARD_PAN_PIXELS],
        ArrowDown: [0, -KEYBOARD_PAN_PIXELS],
        ArrowLeft: [KEYBOARD_PAN_PIXELS, 0],
        ArrowRight: [-KEYBOARD_PAN_PIXELS, 0],
      };

      if (panKeys[event.key]) {
        event.preventDefault();
        panByPixels(...panKeys[event.key]);
        return;
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomIn();
        return;
      }

      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomOut();
        return;
      }

      if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    },
    [panByPixels, resetView, zoomIn, zoomOut],
  );

  /** True when the last pointer sequence was a pan — used to swallow clicks. */
  const hasPanned = useCallback(() => hasPannedRef.current, []);

  const toScreen = useCallback(
    (worldPoint) => ({
      x: size.width / 2 + (worldPoint.x - viewport.x) * viewport.zoom,
      y: size.height / 2 + (worldPoint.y - viewport.y) * viewport.zoom,
    }),
    [size.height, size.width, viewport.x, viewport.y, viewport.zoom],
  );

  const transform =
    viewport.zoom > 0
      ? `translate(${size.width / 2} ${size.height / 2}) scale(${viewport.zoom}) translate(${-viewport.x} ${-viewport.y})`
      : undefined;

  return {
    containerRef,
    size,
    viewport,
    transform,
    isPanning,
    /** 1 at the fitted view, larger the closer the user gets. Drives detail levels. */
    zoomRatio: fitZoom > 0 ? viewport.zoom / fitZoom : 1,
    canZoomIn: viewport.zoom > 0 && viewport.zoom < MAX_ZOOM,
    canZoomOut: fitZoom > 0 && viewport.zoom > fitZoom * MIN_ZOOM_FACTOR * 1.001,
    zoomIn,
    zoomOut,
    resetView,
    focusOnBounds,
    hasPanned,
    toScreen,
    handlers: {
      onPointerDown: handlePointerDown,
      onKeyDown: handleKeyDown,
    },
  };
}
