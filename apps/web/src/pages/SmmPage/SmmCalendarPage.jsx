import { useMemo, useState } from 'react';
import SmmIcon from '../../features/smm/SmmIcon.jsx';
import { useSmmData } from '../../features/smm/SmmDataContext.jsx';
import {
  formatDate,
  getPlatformClassName,
  getStatusClassName,
} from '../../features/smm/smmUtils.js';
import styles from './SmmPage.module.css';

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

function toDateKey(year, month, day) {
  return [
    year,
    String(month + 1).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function SmmCalendarPage() {
  const { publications } = useSmmData();
  const [view, setView] = useState('calendar');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [visibleMonth, setVisibleMonth] = useState(
    () => new Date('2026-06-01T12:00:00'),
  );

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const mondayOffset = (firstDay + 6) % 7;
  const monthLabel = new Intl.DateTimeFormat('uk-UA', {
    month: 'long',
    year: 'numeric',
  }).format(visibleMonth);

  const monthPublications = useMemo(
    () =>
      publications
        .filter((publication) => {
          const publicationDate = new Date(
            `${publication.publishDate}T12:00:00`,
          );

          return (
            publicationDate.getFullYear() === year &&
            publicationDate.getMonth() === month &&
            (platformFilter === 'all' ||
              publication.platform === platformFilter)
          );
        })
        .sort((first, second) =>
          first.publishDate.localeCompare(second.publishDate),
        ),
    [month, platformFilter, publications, year],
  );

  const publicationsByDay = useMemo(() => {
    const groupedPublications = new Map();

    monthPublications.forEach((publication) => {
      const currentItems =
        groupedPublications.get(publication.publishDate) ?? [];
      groupedPublications.set(publication.publishDate, [
        ...currentItems,
        publication,
      ]);
    });

    return groupedPublications;
  }, [monthPublications]);

  const calendarCells = [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  while (calendarCells.length % 7 !== 0) {
    calendarCells.push(null);
  }

  function changeMonth(offset) {
    setVisibleMonth((currentMonth) => {
      const nextMonth = new Date(currentMonth);
      nextMonth.setMonth(currentMonth.getMonth() + offset);
      return nextMonth;
    });
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Графік виходу</p>
          <h1 className={styles.pageTitle}>Календар</h1>
          <p className={styles.pageDescription}>
            Заплановані й опубліковані матеріали в календарному або
            списковому режимі.
          </p>
        </div>

        <div className={styles.viewSwitch} aria-label="Режим відображення">
          <button
            aria-pressed={view === 'calendar'}
            className={view === 'calendar' ? styles.viewSwitchActive : ''}
            onClick={() => setView('calendar')}
            type="button"
          >
            <SmmIcon name="grid" size={17} />
            Календар
          </button>
          <button
            aria-pressed={view === 'list'}
            className={view === 'list' ? styles.viewSwitchActive : ''}
            onClick={() => setView('list')}
            type="button"
          >
            <SmmIcon name="list" size={17} />
            Список
          </button>
        </div>
      </header>

      <section className={styles.calendarPanel}>
        <div className={styles.calendarToolbar}>
          <div className={styles.monthNavigation}>
            <button
              aria-label="Попередній місяць"
              onClick={() => changeMonth(-1)}
              type="button"
            >
              <SmmIcon name="chevronLeft" size={19} />
            </button>
            <h2>{monthLabel}</h2>
            <button
              aria-label="Наступний місяць"
              onClick={() => changeMonth(1)}
              type="button"
            >
              <SmmIcon name="chevronRight" size={19} />
            </button>
          </div>

          <div className={styles.segmentedControl}>
            {['all', 'Instagram', 'YouTube'].map((platform) => (
              <button
                className={
                  platformFilter === platform ? styles.segmentActive : ''
                }
                key={platform}
                onClick={() => setPlatformFilter(platform)}
                type="button"
              >
                {platform === 'all' ? 'Усі платформи' : platform}
              </button>
            ))}
          </div>
        </div>

        {view === 'calendar' ? (
          <div className={styles.calendarWrap}>
            <div className={styles.weekHeader}>
              {weekDays.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className={styles.calendarGrid}>
              {calendarCells.map((day, index) => {
                if (!day) {
                  return (
                    <div
                      className={styles.calendarDayMuted}
                      key={`empty-${index}`}
                    />
                  );
                }

                const dateKey = toDateKey(year, month, day);
                const dayPublications =
                  publicationsByDay.get(dateKey) ?? [];
                const isToday =
                  dateKey === new Date().toISOString().slice(0, 10);

                return (
                  <div className={styles.calendarDay} key={dateKey}>
                    <span
                      className={isToday ? styles.todayNumber : undefined}
                    >
                      {day}
                    </span>

                    <div className={styles.calendarEvents}>
                      {dayPublications.map((publication) => (
                        <article
                          className={`${styles.calendarEvent} ${
                            styles[
                              `calendarEvent-${getPlatformClassName(
                                publication.platform,
                              )}`
                            ]
                          }`}
                          key={publication.id}
                          title={`${publication.title} — ${publication.status}`}
                        >
                          <strong>{publication.title}</strong>
                          <span>
                            {publication.format} · {publication.status}
                          </span>
                        </article>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className={styles.calendarList}>
            <div className={styles.calendarListHeader}>
              <span>Дата</span>
              <span>Назва</span>
              <span>Платформа</span>
              <span>Формат</span>
              <span>Статус</span>
            </div>

            {monthPublications.map((publication) => (
              <article
                className={styles.calendarListItem}
                key={publication.id}
              >
                <div className={styles.listDate}>
                  <strong>
                    {new Date(
                      `${publication.publishDate}T12:00:00`,
                    ).getDate()}
                  </strong>
                  <span>
                    {new Intl.DateTimeFormat('uk-UA', {
                      month: 'short',
                    }).format(
                      new Date(`${publication.publishDate}T12:00:00`),
                    )}
                  </span>
                </div>
                <strong className={styles.listTitle}>
                  {publication.title}
                </strong>
                <span
                  className={`${styles.platformBadge} ${
                    styles[
                      `platformBadge-${getPlatformClassName(
                        publication.platform,
                      )}`
                    ]
                  }`}
                >
                  <SmmIcon
                    name={
                      publication.platform === 'Instagram'
                        ? 'instagram'
                        : 'youtube'
                    }
                    size={16}
                  />
                  {publication.platform}
                </span>
                <span>{publication.format}</span>
                <span
                  className={`${styles.statusBadge} ${
                    styles[
                      `status-${getStatusClassName(publication.status)}`
                    ]
                  }`}
                >
                  {publication.status}
                </span>
              </article>
            ))}

            {monthPublications.length === 0 && (
              <div className={styles.emptyResults}>
                <SmmIcon name="calendar" size={24} />
                <strong>У цьому місяці публікацій немає</strong>
                <span>
                  Перейдіть до іншого місяця або змініть платформу.
                </span>
              </div>
            )}
          </div>
        )}

        <footer className={styles.calendarLegend}>
          <span>
            <i className={styles.instagramLegend} />
            Instagram
          </span>
          <span>
            <i className={styles.youtubeLegend} />
            YouTube
          </span>
          <span>
            Усього за місяць: <strong>{monthPublications.length}</strong>
          </span>
        </footer>
      </section>
    </main>
  );
}

export default SmmCalendarPage;
