/**
 * Container for the selected-house card. Owns nothing but the presentation of
 * the panel's five states: loading, load error, nothing selected, viewing and
 * editing.
 */

import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import { formatDistance } from '../../../features/elections/geo.js';
import { getFillStatus, getHouseTypeLabel } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import HouseEditForm from './HouseEditForm.jsx';
import HouseSummary from './HouseSummary.jsx';
import styles from '../ElectionsPage.module.css';

const statusPillClassNames = {
  complete: styles.pillComplete,
  partial: styles.pillPartial,
  empty: styles.pillEmpty,
};

function PanelShell({ children, className }) {
  return (
    <section className={[styles.detailsPanel, className].filter(Boolean).join(' ')}>
      {children}
    </section>
  );
}

function HouseDetailsPanel({
  house,
  isLoading,
  hasError,
  isEditing,
  isSaving,
  saveError,
  saveNotice,
  onStartEditing,
  onCancelEditing,
  onSave,
  onClose,
}) {
  if (isLoading) {
    return (
      <PanelShell>
        <div className={styles.panelPlaceholder} role="status">
          <span className={styles.placeholderTitle} />
          <span className={styles.placeholderLine} />
          <span className={styles.placeholderLine} />
          <div className={styles.placeholderGrid}>
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="sr-only">Завантаження даних будинку</span>
        </div>
      </PanelShell>
    );
  }

  if (hasError) {
    return (
      <PanelShell>
        <div className={styles.panelEmpty}>
          <span aria-hidden="true" className={styles.panelEmptyIcon}>
            <ElectionsIcon name="warning" size={26} />
          </span>

          <h2>Дані недоступні</h2>
          <p>
            Картку будинку не показати, поки не завантажені дані території.
            Скористайтеся кнопкою повторної спроби на карті.
          </p>
        </div>
      </PanelShell>
    );
  }

  if (!house) {
    return (
      <PanelShell>
        <div className={styles.panelEmpty}>
          <span aria-hidden="true" className={styles.panelEmptyIcon}>
            <ElectionsIcon name="pin" size={26} />
          </span>

          <h2>Будинок не вибрано</h2>
          <p>
            Натисніть на будинок на карті або виберіть його зі списку, щоб
            побачити підʼїзди, квартири, мешканців і контакти.
          </p>

          <ul className={styles.panelHints}>
            <li>
              <ElectionsIcon name="search" size={15} />
              Знайдіть адресу через пошук — наприклад, «Коласа 6»
            </li>
            <li>
              <ElectionsIcon name="layers" size={15} />
              Легенда карти фільтрує будинки за заповненістю даних
            </li>
            <li>
              <ElectionsIcon name="target" size={15} />
              Колесо мишки або жест двома пальцями змінює масштаб
            </li>
          </ul>
        </div>
      </PanelShell>
    );
  }

  const status = getFillStatus(house);

  return (
    <PanelShell className={styles.detailsPanelFilled}>
      <header className={styles.panelHeader}>
        <div className={styles.panelHeaderTop}>
          <span className={`${styles.statusPill} ${statusPillClassNames[status]}`}>
            {fillStatusesById[status].shortLabel}
          </span>

          {house.isHeadquarters && <span className={styles.hqPill}>Штаб кампанії</span>}

          <button
            aria-label="Закрити картку будинку"
            className={styles.panelClose}
            onClick={onClose}
            type="button"
          >
            <ElectionsIcon name="close" size={18} />
          </button>
        </div>

        <h2 className={styles.panelTitle}>{house.address}</h2>

        <p className={styles.panelSubtitle}>
          {getHouseTypeLabel(house)} · {formatDistance(house.distanceMeters)} від штабу
        </p>

        {isEditing && (
          <p className={styles.panelEditingHint}>
            <ElectionsIcon name="edit" size={15} />
            Режим редагування — зміни застосуються після збереження
          </p>
        )}
      </header>

      {saveNotice && !isEditing && (
        <p className={styles.panelNotice} role="status">
          <ElectionsIcon name="check" size={16} />
          {saveNotice}
        </p>
      )}

      <div className={styles.panelBody}>
        {isEditing ? (
          <HouseEditForm
            house={house}
            isSaving={isSaving}
            key={house.id}
            onCancel={onCancelEditing}
            onSubmit={onSave}
            saveError={saveError}
          />
        ) : (
          <HouseSummary house={house} onStartEditing={onStartEditing} />
        )}
      </div>
    </PanelShell>
  );
}

export default HouseDetailsPanel;
