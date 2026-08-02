/**
 * Page hero: which campaign is open, what the territory is, and how the field
 * work is going.
 *
 * The «Скинути демо-дані» button is gone. It deleted every record anybody had
 * entered, for every house, in one click and with no confirmation, and it was
 * labelled as if it removed sample data. Nothing in this header destroys
 * anything now; the only export it offers is the *rescue* of the old
 * browser-only data (see `LegacyDataNotice`).
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { formatAreaSquareMeters } from '../../../features/elections/geo.js';
import { formatNumber } from '../../../features/elections/houseUtils.js';
import styles from '../ElectionsPage.module.css';

const ROLE_LABELS = {
  agitator: 'агітатор',
  coordinator: 'координатор',
  manager: 'менеджер',
  admin: 'адміністратор',
};

function ElectionsHeader({
  area,
  campaign,
  campaigns,
  viewer,
  summary,
  isLoading,
  isAreaEditing,
  onSelectCampaign,
  onToggleAreaEditing,
  onOpenImport,
  onOpenBulkAssign,
}) {
  const done = summary.byStage?.done ?? 0;
  const coveragePercent = summary.total > 0 ? Math.round((done / summary.total) * 100) : 0;
  const role = viewer?.role ?? null;
  const canManage = role === 'manager' || role === 'admin';

  const stats = [
    {
      id: 'houses',
      icon: 'building',
      label: 'Будинків у зоні',
      value: formatNumber(summary.total),
      hint: `Площа ${formatAreaSquareMeters(area.areaSqm)}`,
    },
    {
      id: 'done',
      icon: 'check',
      label: 'Завершено',
      value: formatNumber(done),
      hint: `${coveragePercent}% території`,
      tone: 'success',
    },
    {
      id: 'attention',
      icon: 'warning',
      label: 'Потребують уваги',
      value: formatNumber(summary.overdueTasks + summary.openIssues),
      hint: `Прострочено: ${formatNumber(summary.overdueTasks)} · звернень: ${
        formatNumber(summary.openIssues)
      }`,
      tone: 'warning',
    },
    {
      id: 'unassigned',
      icon: 'users',
      label: 'Без відповідального',
      value: formatNumber(summary.withoutAssignee),
      hint: `Є контакт: ${formatNumber(summary.knownContacts)}`,
    },
  ];

  return (
    <header className={styles.hero}>
      <div className={styles.heroMain}>
        <p className={styles.eyebrow}>Польова робота</p>
        <h1 className={styles.title}>Вибори</h1>

        <div className={styles.campaignBar}>
          <label className={styles.selectField}>
            <span className="sr-only">Кампанія</span>
            <select
              disabled={campaigns.length === 0}
              onChange={(event) => onSelectCampaign(event.target.value)}
              value={campaign?.id ?? ''}
            >
              {campaigns.length === 0 && <option value="">Кампанії ще немає</option>}
              {campaigns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.status === 'archived' ? ' (архів)' : ''}
                  {item.status === 'draft' ? ' (чернетка)' : ''}
                </option>
              ))}
            </select>
          </label>

          {campaign?.status === 'archived' && (
            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
              Архівна кампанія — лише перегляд
            </span>
          )}

          {viewer && (
            <span className={styles.viewerBadge}>
              <ElectionsIcon name="contacts" size={14} />
              {viewer.email ?? 'без входу'}
              {role ? ` · ${ROLE_LABELS[role] ?? role}` : ' · без ролі'}
            </span>
          )}

          {/* A development override must be obvious on screen, not only in the
              server log — otherwise it reads as a normal signed-in session. */}
          {viewer?.isDevAuth && (
            <span className={`${styles.badge} ${styles.badgeDanger}`}>
              Увімкнено режим розробки — права видані локально
            </span>
          )}

          {/* Same reasoning for the LAN stand-in: the rights are real, but they
              come from the deployment's configuration rather than from a login,
              so the screen has to say so. */}
          {viewer?.isLocalAuth && !viewer?.isDevAuth && (
            <span className={`${styles.badge} ${styles.badgeNeutral}`}>
              Локальний доступ у мережі — права з ELECTIONS_LOCAL_EMAIL
            </span>
          )}
        </div>

        <p className={styles.heroAddress}>
          <span aria-hidden="true" className={styles.heroPin}>
            <ElectionsIcon name="pin" size={17} />
          </span>

          <span>
            <strong>{campaign?.hqAddress || area.center.address}</strong>
            <small>
              {area.center.city}, {area.center.postalCode} · {area.center.district} ·{' '}
              {area.name}, {formatAreaSquareMeters(area.areaSqm)}
              {area.isCustom ? ' · межу обведено вручну' : ''}
            </small>
          </span>
        </p>

        <div className={styles.heroActions}>
          {/* The whole module works on whatever this polygon covers, so redrawing
              it is a page-level action and lives next to the address it frames. */}
          {role === 'admin' && (
            <button
              aria-pressed={isAreaEditing}
              className={styles.primaryButton}
              onClick={onToggleAreaEditing}
              type="button"
            >
              <ElectionsIcon name={isAreaEditing ? 'close' : 'edit'} size={16} />
              {isAreaEditing ? 'Завершити редагування межі' : 'Редагувати межу'}
            </button>
          )}

          {canManage && (
            <button className={styles.ghostButton} onClick={onOpenBulkAssign} type="button">
              <ElectionsIcon name="users" size={16} />
              Масове призначення
            </button>
          )}

          {role === 'admin' && (
            <button className={styles.ghostButton} onClick={onOpenImport} type="button">
              <ElectionsIcon name="layers" size={16} />
              Імпорт даних
            </button>
          )}

          <span className={styles.demoNotice}>
            <ElectionsIcon name="info" size={15} />
            {isLoading
              ? 'Завантаження даних…'
              : 'Будинки — OpenStreetMap; робочі дані зберігаються на сервері'}
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
