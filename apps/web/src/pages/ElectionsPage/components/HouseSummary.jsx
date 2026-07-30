/**
 * Read-only view of a selected house.
 *
 * Values that were never surveyed fall back to the geometry estimate and are
 * labelled "оціночно", so a coordinator can always tell measured data from a
 * guess.
 */

import {
  COMPLETION_FIELDS,
  contactTypesById,
  fillStatusesById,
} from '../../../features/elections/electionsTypes.js';
import { formatDistance } from '../../../features/elections/geo.js';
import {
  formatFloors,
  formatNumber,
  formatSurveyDate,
  formatUpdatedAt,
  getAgeGroupLabel,
  getCanvassStatus,
  getCompletedFields,
  getFillStatus,
  getHouseTypeLabel,
  getMissingFieldLabels,
  getPriority,
  getStanceBreakdown,
  getStanceLabel,
  resolveApartments,
  resolveEntrances,
  resolveResidents,
} from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const toneClassNames = {
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
  info: styles.badgeInfo,
  neutral: styles.badgeNeutral,
};

/** Turns a contact into something clickable where the channel allows it. */
function contactHref(contact) {
  const value = contact.value.trim();

  if (!value) {
    return null;
  }

  if (contact.type === 'phone') {
    return `tel:${value.replace(/[^\d+]/g, '')}`;
  }

  if (contact.type === 'viber') {
    return `viber://chat?number=${encodeURIComponent(value.replace(/[^\d+]/g, ''))}`;
  }

  if (contact.type === 'email') {
    return `mailto:${value}`;
  }

  if (contact.type === 'telegram') {
    return `https://t.me/${value.replace(/^@/, '')}`;
  }

  return null;
}

function Metric({ icon, label, value, hint, isEstimate }) {
  return (
    <div className={styles.metric}>
      <span aria-hidden="true" className={styles.metricIcon}>
        <ElectionsIcon name={icon} size={16} />
      </span>

      <strong className={styles.metricValue}>{value}</strong>
      <span className={styles.metricLabel}>{label}</span>

      {(hint || isEstimate) && (
        <small className={isEstimate ? styles.metricEstimate : styles.metricHint}>
          {isEstimate ? 'оціночно, за геометрією' : hint}
        </small>
      )}
    </div>
  );
}

/**
 * A survey metric that has neither a confirmed value nor a geometry estimate
 * says so, rather than showing a zero somebody could mistake for data.
 */
function metricHint(resolved) {
  return resolved.isKnown ? undefined : 'даних немає — заповніть картку';
}

function HouseSummary({ house, onStartEditing }) {
  const status = getFillStatus(house);
  const completedCount = getCompletedFields(house.details).length;
  const missingFields = getMissingFieldLabels(house);
  const entrances = resolveEntrances(house);
  const apartments = resolveApartments(house);
  const residents = resolveResidents(house);
  const canvassStatus = getCanvassStatus(house);
  const priority = getPriority(house);
  const stances = getStanceBreakdown(house).filter((stance) => stance.count > 0);
  const knownResidents = house.details.residents ?? [];
  const contacts = (house.details.contacts ?? []).filter((contact) => contact.value.trim());

  return (
    <div className={styles.summary}>
      <div className={styles.completeness}>
        <div className={styles.completenessTop}>
          <span className={`${styles.badge} ${toneClassNames[fillStatusesById[status].tone]}`}>
            {fillStatusesById[status].label}
          </span>

          <span className={styles.completenessCount}>
            {completedCount} з {COMPLETION_FIELDS.length} блоків
          </span>
        </div>

        <span className={styles.completenessTrack}>
          <span
            className={styles.completenessFill}
            data-status={status}
            style={{ width: `${(completedCount / COMPLETION_FIELDS.length) * 100}%` }}
          />
        </span>

        {missingFields.length > 0 && (
          <p className={styles.completenessMissing}>
            Не заповнено: {missingFields.join(', ').toLowerCase()}
          </p>
        )}
      </div>

      <div className={styles.metricGrid}>
        <Metric
          hint={metricHint(entrances)}
          icon="door"
          isEstimate={entrances.isEstimate}
          label="Підʼїзди"
          value={formatNumber(entrances.value)}
        />
        <Metric
          hint={metricHint(apartments)}
          icon="home"
          isEstimate={apartments.isEstimate}
          label="Квартири"
          value={formatNumber(apartments.value)}
        />
        <Metric
          hint={metricHint(residents)}
          icon="users"
          isEstimate={residents.isEstimate}
          label="Мешканці"
          value={formatNumber(residents.value)}
        />
        <Metric
          hint={
            house.builtYear
              ? `${house.builtYear} рік`
              : `забудова ${formatNumber(house.footprintAreaSqm)} м²`
          }
          icon="building"
          label={getHouseTypeLabel(house)}
          value={
            Number.isFinite(house.floors) ? formatFloors(house.floors) : 'Поверхи невідомі'
          }
        />
      </div>

      <dl className={styles.factList}>
        <div>
          <dt>Повна адреса</dt>
          <dd>{house.fullAddress}</dd>
        </div>

        <div>
          <dt>Відстань від штабу</dt>
          <dd>{formatDistance(house.distanceMeters)}</dd>
        </div>

        {/* The outline and the address are somebody's OSM edit — link to it,
            so a wrong house number can be checked and fixed at the source. */}
        <div>
          <dt>Обʼєкт на карті</dt>
          <dd>
            <a
              className={styles.factLink}
              href={`https://www.openstreetmap.org/${house.osmType}/${house.osmId}`}
              rel="noreferrer noopener"
              target="_blank"
            >
              OpenStreetMap · building={house.building}
              <ElectionsIcon name="link" size={13} />
            </a>
          </dd>
        </div>

        <div>
          <dt>Стан обходу</dt>
          <dd>
            <span className={`${styles.badge} ${toneClassNames[canvassStatus.tone]}`}>
              {canvassStatus.label}
            </span>
            <span className={`${styles.badge} ${toneClassNames[priority.tone]}`}>
              Пріоритет: {priority.label.toLowerCase()}
            </span>
          </dd>
        </div>

        <div>
          <dt>Дата обходу</dt>
          <dd>{formatSurveyDate(house.details.surveyedAt)}</dd>
        </div>

        {house.details.householdsCount !== null && (
          <div>
            <dt>Заселених квартир</dt>
            <dd>{formatNumber(house.details.householdsCount)}</dd>
          </div>
        )}

        {house.details.accessNote && (
          <div>
            <dt>Доступ</dt>
            <dd>{house.details.accessNote}</dd>
          </div>
        )}
      </dl>

      <section className={styles.summarySection}>
        <h3 className={styles.summarySectionTitle}>
          <ElectionsIcon name="users" size={16} />
          Мешканці
          {knownResidents.length > 0 && (
            <span className={styles.summaryCount}>{knownResidents.length}</span>
          )}
        </h3>

        {stances.length > 0 && (
          <ul className={styles.stanceRow}>
            {stances.map((stance) => (
              <li className={`${styles.badge} ${toneClassNames[stance.tone]}`} key={stance.id}>
                {stance.label}: {stance.count}
              </li>
            ))}
          </ul>
        )}

        {knownResidents.length === 0 ? (
          <p className={styles.summaryEmpty}>
            Інформації про мешканців ще немає. Додайте її після першого обходу.
          </p>
        ) : (
          <ul className={styles.residentList}>
            {knownResidents.map((resident) => (
              <li className={styles.residentCard} key={resident.id}>
                <div className={styles.residentTop}>
                  <strong>{resident.name}</strong>
                  {resident.apartment && (
                    <span className={styles.residentApartment}>кв. {resident.apartment}</span>
                  )}
                </div>

                <div className={styles.residentMeta}>
                  <span className={styles.residentStance} data-stance={resident.stance}>
                    {getStanceLabel(resident.stance)}
                  </span>
                  <span>{getAgeGroupLabel(resident.ageGroup)}</span>
                </div>

                {resident.note && <p className={styles.residentNote}>{resident.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.summarySection}>
        <h3 className={styles.summarySectionTitle}>
          <ElectionsIcon name="contacts" size={16} />
          Контактні дані
          {contacts.length > 0 && (
            <span className={styles.summaryCount}>{contacts.length}</span>
          )}
        </h3>

        {contacts.length === 0 ? (
          <p className={styles.summaryEmpty}>
            Контактів немає. Телефон старости чи голови ОСББ суттєво спрощує
            наступний обхід.
          </p>
        ) : (
          <ul className={styles.contactList}>
            {contacts.map((contact) => {
              const href = contactHref(contact);
              const typeMeta = contactTypesById[contact.type];

              return (
                <li className={styles.contactRow} key={contact.id}>
                  <span aria-hidden="true" className={styles.contactIcon}>
                    <ElectionsIcon name={typeMeta?.icon ?? 'link'} size={16} />
                  </span>

                  <span className={styles.contactBody}>
                    {href ? (
                      <a className={styles.contactValue} href={href}>
                        {contact.value}
                      </a>
                    ) : (
                      <span className={styles.contactValue}>{contact.value}</span>
                    )}

                    <small>{contact.label || typeMeta?.label}</small>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.summarySection}>
        <h3 className={styles.summarySectionTitle}>
          <ElectionsIcon name="note" size={16} />
          Нотатки
        </h3>

        {house.details.notes ? (
          <p className={styles.notesBody}>{house.details.notes}</p>
        ) : (
          <p className={styles.summaryEmpty}>
            Нотаток немає. Тут стане в пригоді все, що допоможе наступному
            координатору: настрої, зручний час, локальні проблеми.
          </p>
        )}
      </section>

      <footer className={styles.summaryFooter}>
        <small>
          {house.details.updatedBy
            ? `${formatUpdatedAt(house.details.updatedAt)} · ${house.details.updatedBy}`
            : formatUpdatedAt(house.details.updatedAt)}
        </small>

        <button className={styles.primaryButton} onClick={onStartEditing} type="button">
          <ElectionsIcon name="edit" size={17} />
          {status === 'empty' ? 'Заповнити дані' : 'Редагувати дані'}
        </button>
      </footer>
    </div>
  );
}

export default HouseSummary;
