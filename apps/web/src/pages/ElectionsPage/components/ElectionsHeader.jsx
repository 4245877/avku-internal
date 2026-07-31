/**
 * Page hero: what the territory is, and how far the survey has got.
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { formatAreaSquareMeters } from '../../../features/elections/geo.js';
import { formatNumber } from '../../../features/elections/houseUtils.js';
import styles from '../ElectionsPage.module.css';

function ElectionsHeader({
  area,
  summary,
  isLoading,
  isAreaEditing,
  onResetDemoData,
  onToggleAreaEditing,
}) {
  const coveragePercent =
    summary.total > 0 ? Math.round((summary.complete / summary.total) * 100) : 0;

  const stats = [
    {
      id: 'houses',
      icon: 'building',
      label: 'Будинків у зоні',
      value: formatNumber(summary.total),
      hint: `Площа ${formatAreaSquareMeters(area.areaSqm)}`,
    },
    {
      id: 'complete',
      icon: 'check',
      label: 'Дані заповнені',
      value: formatNumber(summary.complete),
      hint: `${coveragePercent}% покриття`,
      tone: 'success',
    },
    {
      id: 'pending',
      icon: 'note',
      label: 'Потребують обходу',
      value: formatNumber(summary.partial + summary.empty),
      hint: `Частково: ${formatNumber(summary.partial)}`,
      tone: 'warning',
    },
    {
      id: 'residents',
      icon: 'users',
      label: 'Мешканців, орієнтовно',
      value: formatNumber(summary.residents),
      hint: `${formatNumber(summary.apartments)} квартир`,
    },
  ];

  return (
    <header className={styles.hero}>
      <div className={styles.heroMain}>
        <p className={styles.eyebrow}>Польова робота</p>
        <h1 className={styles.title}>Вибори</h1>

        <p className={styles.heroAddress}>
          <span aria-hidden="true" className={styles.heroPin}>
            <ElectionsIcon name="pin" size={17} />
          </span>

          <span>
            <strong>{area.center.address}</strong>
            <small>
              {area.center.city}, {area.center.postalCode} · {area.center.district} ·{' '}
              {area.name}, {formatAreaSquareMeters(area.areaSqm)}
              {area.isCustom ? ' · межу обведено вручну' : ''}
            </small>
          </span>
        </p>

        <p className={styles.heroDescription}>
          Інтерактивна карта реальних будинків у межах робочої території за
          даними OpenStreetMap. Натисніть на будинок, щоб відкрити картку, переглянути
          підʼїзди, квартири, мешканців і контакти або внести нові дані після
          обходу.
        </p>

        <div className={styles.heroActions}>
          {/* The whole module works on whatever this polygon covers, so redrawing
              it is a page-level action and lives next to the address it frames. */}
          <button
            aria-pressed={isAreaEditing}
            className={styles.primaryButton}
            onClick={onToggleAreaEditing}
            type="button"
          >
            <ElectionsIcon name={isAreaEditing ? 'close' : 'edit'} size={16} />
            {isAreaEditing ? 'Завершити редагування межі' : 'Редагувати межу'}
          </button>

          <button
            className={styles.ghostButton}
            disabled={isLoading}
            onClick={onResetDemoData}
            type="button"
          >
            <ElectionsIcon name="refresh" size={16} />
            Скинути внесені дані
          </button>

          <span className={styles.demoNotice}>
            <ElectionsIcon name="info" size={15} />
            Будинки — OpenStreetMap; внесені дані зберігаються локально
          </span>
        </div>
      </div>

      <div className={styles.heroStats}>
        {stats.map((stat) => (
          <article
            className={[
              styles.statTile,
              stat.tone === 'success' ? styles.statTileSuccess : '',
              stat.tone === 'warning' ? styles.statTileWarning : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={stat.id}
          >
            <span aria-hidden="true" className={styles.statIcon}>
              <ElectionsIcon name={stat.icon} size={17} />
            </span>

            <strong className={styles.statValue}>{isLoading ? '—' : stat.value}</strong>
            <span className={styles.statLabel}>{stat.label}</span>
            <small className={styles.statHint}>{isLoading ? '…' : stat.hint}</small>
          </article>
        ))}
      </div>
    </header>
  );
}

export default ElectionsHeader;
