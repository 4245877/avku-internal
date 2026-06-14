import React, { useMemo, useState } from 'react';
import styles from './DashboardPage.module.css';
import { exportAsJson, exportAsCsv } from '../../features/export/exportRecords';

const summaryCards = [
  {
    label: 'Усього записів',
    value: 128,
    hint: 'Запити, передачі, звіти, публікації',
  },
  {
    label: 'Активні запити',
    value: 24,
    hint: 'Потребують обробки або виконання',
  },
  {
    label: 'Передачі допомоги',
    value: 57,
    hint: 'Зафіксовані факти передачі',
  },
  {
    label: 'Готові звіти',
    value: 31,
    hint: 'Можна використовувати для прозорості',
  },
];

const statusItems = [
  { label: 'Нові', value: 12 },
  { label: 'У роботі', value: 18 },
  { label: 'Очікують документів', value: 7 },
  { label: 'Готові до звіту', value: 9 },
  { label: 'Опубліковані', value: 22 },
];

const recentRecords = [
  {
    id: 'REQ-2026-0012',
    type: 'Запит',
    title: 'Потреба у засобах живлення для підрозділу',
    status: 'У роботі',
    responsible: 'Богдан Колодій',
    date: '2026-05-21',
    statusTone: 'progress',
  },
  {
    id: 'DEL-2026-0041',
    type: 'Передача',
    title: 'Передано гуманітарні набори',
    status: 'Готово до звіту',
    responsible: 'Команда Київ',
    date: '2026-05-20',
    statusTone: 'ready',
  },
  {
    id: 'REP-2026-0018',
    type: 'Звіт',
    title: 'Фотозвіт щодо допомоги захисникам',
    status: 'Опубліковано',
    responsible: 'Адміністратор',
    date: '2026-05-19',
    statusTone: 'published',
  },
  {
    id: 'PUB-2026-0024',
    type: 'Публікація',
    title: 'Матеріал для Facebook та сайту',
    status: 'Чернетка',
    responsible: 'Редактор',
    date: '2026-05-18',
    statusTone: 'draft',
  },
];

const quickActions = [
  'Створити запит',
  'Додати передачу',
  'Завантажити файли',
  'Сформувати звіт',
  'Підготувати публікацію',
];

function DashboardPage() {
  const [search, setSearch] = useState('');

  const filteredRecords = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return recentRecords;
    }

    return recentRecords.filter((record) => {
      return [
        record.id,
        record.type,
        record.title,
        record.status,
        record.responsible,
        record.date,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [search]);

  const exportPayload = {
    generatedAt: new Date().toISOString(),
    source: 'AVKU Admin Dashboard',
    summary: summaryCards,
    statuses: statusItems,
    records: filteredRecords,
  };

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>АВКУ / внутрішня система</p>
          <h1 className={styles.title}>Панель моніторингу записів</h1>
          <p className={styles.description}>
            Єдиний центр для контролю запитів, передач допомоги, фото,
            документів, звітів, публікацій, партнерів і відповідальних осіб.
          </p>
        </div>

        <div className={styles.heroActions}>
          <button className={styles.primaryButton}>Створити запис</button>
          <button
            className={styles.secondaryButton}
            onClick={() => exportAsJson(exportPayload, 'avku-dashboard-export.json')}
          >
            Експорт JSON
          </button>
          <button
            className={styles.secondaryButton}
            onClick={() => exportAsCsv(filteredRecords, 'avku-records.csv')}
          >
            Експорт CSV
          </button>
        </div>
      </section>

      <section className={styles.summaryGrid} aria-label="Оперативна статистика">
        {summaryCards.map((card) => (
          <article className={styles.summaryCard} key={card.label}>
            <p className={styles.cardLabel}>{card.label}</p>
            <strong className={styles.cardValue}>{card.value}</strong>
            <span className={styles.cardHint}>{card.hint}</span>
          </article>
        ))}
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>Останні записи</h2>
              <p className={styles.panelText}>
                Швидкий перегляд того, що потребує уваги.
              </p>
            </div>

            <input
              className={styles.searchInput}
              type="search"
              aria-label="Пошук записів"
              placeholder="Пошук за назвою, статусом або ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Тип</th>
                  <th>Назва</th>
                  <th>Статус</th>
                  <th>Відповідальний</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record) => (
                  <tr key={record.id}>
                    <td>{record.id}</td>
                    <td>{record.type}</td>
                    <td>{record.title}</td>
                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          styles[`statusBadge-${record.statusTone}`]
                        }`}
                      >
                        {record.status}
                      </span>
                    </td>
                    <td>{record.responsible}</td>
                    <td>{record.date}</td>
                  </tr>
                ))}
                {filteredRecords.length === 0 && (
                  <tr>
                    <td className={styles.emptyTableCell} colSpan={6}>
                      За вашим запитом записів не знайдено.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <aside className={styles.sideColumn}>
          <article className={styles.panel}>
            <h2 className={styles.panelTitle}>Стани роботи</h2>

            <div className={styles.statusList}>
              {statusItems.map((item) => (
                <div className={styles.statusItem} key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </article>

          <article className={styles.panel}>
            <h2 className={styles.panelTitle}>Швидкі дії</h2>

            <div className={styles.actionList}>
              {quickActions.map((action) => (
                <button className={styles.actionButton} key={action}>
                  {action}
                </button>
              ))}
            </div>
          </article>

          <article className={styles.aiPanel}>
            <p className={styles.eyebrow}>Для аналізу з ШІ</p>
            <h2 className={styles.panelTitle}>Чистий експорт даних</h2>
            <p className={styles.panelText}>
              JSON-експорт зберігає структуру записів, статусів, дат,
              відповідальних осіб і зв’язків між сутностями.
            </p>
          </article>
        </aside>
      </section>
    </main>
  );
}

export default DashboardPage;
