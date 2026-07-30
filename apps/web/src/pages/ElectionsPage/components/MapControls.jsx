/**
 * Floating zoom / recentre controls.
 *
 * The scale bar is Leaflet's own (added in `useLeafletMap`) — it has to agree
 * with the projection of the base tiles, which only the map itself knows.
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function MapControls({ canZoomIn, canZoomOut, onZoomIn, onZoomOut, onReset }) {
  return (
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
  );
}

export default MapControls;
