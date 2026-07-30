/**
 * Floating zoom / recentre controls and the scale bar overlay.
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

/** Round distances a scale bar is allowed to show, in metres. */
const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000];
/** Preferred on-screen length of the scale bar. */
const SCALE_TARGET_PIXELS = 110;

function buildScale(zoom) {
  if (!zoom) {
    return null;
  }

  const targetMeters = SCALE_TARGET_PIXELS / zoom;
  const meters = SCALE_STEPS.find((step) => step >= targetMeters) ?? SCALE_STEPS.at(-1);

  return {
    meters,
    label: meters >= 1000 ? `${meters / 1000} км` : `${meters} м`,
    width: Math.round(meters * zoom),
  };
}

function MapControls({ zoom, canZoomIn, canZoomOut, onZoomIn, onZoomOut, onReset }) {
  const scale = buildScale(zoom);

  return (
    <>
      <div className={styles.mapControls} data-map-overlay="">
        <button
          aria-label="Збільшити масштаб"
          className={styles.mapControlButton}
          disabled={!canZoomIn}
          onClick={onZoomIn}
          type="button"
        >
          <ElectionsIcon name="zoomIn" size={18} />
        </button>

        <button
          aria-label="Зменшити масштаб"
          className={styles.mapControlButton}
          disabled={!canZoomOut}
          onClick={onZoomOut}
          type="button"
        >
          <ElectionsIcon name="zoomOut" size={18} />
        </button>

        <button
          aria-label="Показати всю територію"
          className={styles.mapControlButton}
          onClick={onReset}
          type="button"
        >
          <ElectionsIcon name="target" size={18} />
        </button>
      </div>

      {scale && (
        <div className={styles.mapScale} data-map-overlay="">
          <span className={styles.mapScaleBar} style={{ width: `${scale.width}px` }} />
          <span className={styles.mapScaleLabel}>{scale.label}</span>
        </div>
      )}
    </>
  );
}

export default MapControls;
