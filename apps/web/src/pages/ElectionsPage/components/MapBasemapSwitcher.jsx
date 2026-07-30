/**
 * Base layer picker. Which providers appear here is decided in
 * `features/elections/basemaps.js` — commercial ones show up automatically once
 * their token is configured.
 */

import { BASEMAPS } from '../../../features/elections/basemaps.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function MapBasemapSwitcher({ activeId, onChange }) {
  if (BASEMAPS.length < 2) {
    return null;
  }

  return (
    <div className={styles.mapBasemaps} data-map-overlay="">
      <p className={styles.mapBasemapsTitle}>
        <ElectionsIcon name="layers" size={15} />
        <span className="sr-only">Базова карта</span>
      </p>

      <div className={styles.mapBasemapList} role="radiogroup" aria-label="Базова карта">
        {BASEMAPS.map((basemap) => (
          <button
            aria-checked={activeId === basemap.id}
            className={[
              styles.mapBasemapButton,
              activeId === basemap.id ? styles.mapBasemapButtonActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={basemap.id}
            onClick={() => onChange(basemap.id)}
            role="radio"
            title={basemap.hint}
            type="button"
          >
            {basemap.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default MapBasemapSwitcher;
