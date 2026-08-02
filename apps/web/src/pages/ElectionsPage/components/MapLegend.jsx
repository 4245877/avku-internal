/**
 * Map legend, in two parts — which is the point of it.
 *
 * The top half explains the **colour**, and the colour means one thing: the
 * stage of work in the active campaign. Each row doubles as a filter.
 *
 * The bottom half explains the **signals** drawn on top of the colour: a thick
 * outline for high priority, a dashed one for a house nobody owns, a faded fill
 * for data that has not been checked in months, and a corner badge for overdue
 * work. They are listed separately because they are separate facts — a finished
 * house can still have an unresolved complaint on it.
 */

import { WORK_STAGES } from '../../../features/elections/electionsTypes.js';
import { formatNumber } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const SIGNALS = [
  { id: 'urgent', label: 'Високий пріоритет', hint: 'товста обводка' },
  { id: 'unassigned', label: 'Немає відповідального', hint: 'пунктир' },
  { id: 'stale', label: 'Дані не перевірялись', hint: 'бліда заливка' },
  { id: 'overdue', label: 'Прострочене або звернення', hint: 'значок у куті' },
];

function MapLegend({ summary, activeStage, onStageChange, headquartersLabel }) {
  // A summary computed before the first load has no per-stage counts yet; the
  // legend is still drawn, with zeros, rather than blanking the map corner.
  const byStage = summary?.byStage ?? {};

  return (
    <div className={styles.mapLegend} data-map-overlay="">
      <p className={styles.mapLegendTitle}>
        <ElectionsIcon name="layers" size={15} />
        Етап роботи
      </p>

      <ul className={styles.mapLegendList}>
        {WORK_STAGES.map((stage) => {
          const isActive = activeStage === stage.id;
          const count = byStage[stage.id] ?? 0;

          return (
            <li key={stage.id}>
              <button
                aria-pressed={isActive}
                className={[styles.mapLegendRow, isActive ? styles.mapLegendRowActive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onStageChange(isActive ? 'all' : stage.id)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={styles.swatch}
                  data-stage={stage.id}
                />
                <span className={styles.mapLegendLabel}>{stage.short}</span>
                <span className={styles.mapLegendCount}>{formatNumber(count)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className={styles.mapLegendTitle}>
        <ElectionsIcon name="warning" size={15} />
        Окремі ознаки
      </p>

      <ul className={styles.mapSignalList}>
        {SIGNALS.map((signal) => (
          <li key={signal.id}>
            <span aria-hidden="true" className={styles.signalMark} data-signal={signal.id} />
            <span className={styles.mapLegendLabel}>{signal.label}</span>
            <small>{signal.hint}</small>
          </li>
        ))}
      </ul>

      {headquartersLabel && (
        <p className={styles.mapLegendHint}>
          <span aria-hidden="true" className={styles.swatchAnchor} />
          Штаб — {headquartersLabel}
        </p>
      )}
    </div>
  );
}

export default MapLegend;
