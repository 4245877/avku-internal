/**
 * «Карта» ⇄ «Супутник».
 *
 * Two modes, because those are the two questions the map is asked: where the
 * streets and numbers are, and what the ground actually looks like. Which
 * provider serves each is decided in `features/elections/basemaps.js` — a
 * configured commercial token moves both modes at once, and this control does
 * not change.
 *
 * A radiogroup rather than a toggle button: the active mode has to be readable,
 * not inferred from which label is showing.
 */

import { MAP_MODES } from '../../../features/elections/basemaps.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

function MapBasemapSwitcher({ activeId, onChange, tileStatus }) {
  if (MAP_MODES.length < 2) {
    return null;
  }

  return (
    <div className={styles.mapBasemaps} data-map-overlay="">
      <div className={styles.mapBasemapList} role="radiogroup" aria-label="Базова карта">
        {MAP_MODES.map((mode) => {
          const isActive = activeId === mode.id;

          return (
            <button
              aria-checked={isActive}
              className={[
                styles.mapBasemapButton,
                isActive ? styles.mapBasemapButtonActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              key={mode.id}
              onClick={() => onChange(mode.id)}
              role="radio"
              title={mode.hint}
              type="button"
            >
              <ElectionsIcon name={mode.icon} size={15} />
              {mode.label}
              {/* The chip lives inside the active button so the wait is
                  attached to the layer being waited for. */}
              {isActive && tileStatus === 'loading' && (
                <span aria-hidden="true" className={styles.mapBasemapSpinner} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default MapBasemapSwitcher;
