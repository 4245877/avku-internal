import { useMemo, useState } from 'react';
import styles from './AidOperationsPage.module.css';

const transferRecords = [
  {
    id: 'TR-2026-052',
    route: "Київ - Харків - Куп'янський напрямок",
    recipient: 'Медична рота, Харківська область',
    driver: 'Ірина Коваль / бус Renault Master',
    transferDate: '2026-06-27',
    status: 'Заплановано',
    statusTone: 'planned',
    act: 'Акт підготовлено',
    actTone: 'partial',
    photo: 'Очікується після передачі',
    photoTone: 'partial',
    requestId: 'REQ-2026-044',
    warehouseId: 'WH-FOOD-027, WH-MED-009',
    reportId: 'REP-2026-019',
    manifest: [
      { name: 'Продуктові набори', quantity: '45 наборів' },
      { name: 'Аптечки тактичні', quantity: '24 шт. після доукомплектації' },
    ],
    checklist: [
      { label: 'Маршрут погоджено', state: 'Готово', done: true },
      { label: 'Акт передачі', state: 'Чернетка', done: false },
      { label: 'Фото передачі', state: 'Після вручення', done: false },
      { label: 'Звіт', state: 'Створено картку', done: true },
    ],
    notes: 'Перед виїздом перевірити медичну комплектацію та додати турнікети.',
  },
  {
    id: 'TR-2026-049',
    route: 'Львів - Дніпро - стабпункт',
    recipient: 'Стабілізаційний пункт, Дніпропетровська область',
    driver: 'Андрій Мельник / волонтерський екіпаж',
    transferDate: '2026-06-24',
    status: 'Передано',
    statusTone: 'transferred',
    act: 'ACT-2026-049.pdf',
    actTone: 'complete',
    photo: '8 фото завантажено',
    photoTone: 'complete',
    requestId: 'REQ-2026-039',
    warehouseId: 'WH-GEN-014',
    reportId: 'REP-2026-017',
    manifest: [
      { name: 'Генератори 3 кВт', quantity: '2 шт.' },
      { name: 'Окопні свічки', quantity: '120 шт.' },
    ],
    checklist: [
      { label: 'Маршрут погоджено', state: 'Готово', done: true },
      { label: 'Акт передачі', state: 'Підписано', done: true },
      { label: 'Фото передачі', state: 'Завантажено', done: true },
      { label: 'Звіт', state: 'Готовий до публікації', done: true },
    ],
    notes: 'Отримувач підтвердив генератори і свічки у день передачі.',
  },
  {
    id: 'TR-2026-046',
    route: 'Київ - Суми - прикордонна громада',
    recipient: 'Волонтерський штаб Сумської області',
    driver: 'Богдан Колодій / Нова пошта гуманітарна',
    transferDate: '2026-06-21',
    status: 'Потрібно дозавантажити звіт',
    statusTone: 'report',
    act: 'ACT-2026-046.pdf',
    actTone: 'complete',
    photo: 'Фото немає',
    photoTone: 'missing',
    requestId: 'REQ-2026-036',
    warehouseId: 'WH-CLT-033',
    reportId: 'REP-2026-014',
    manifest: [
      { name: 'Термобілизна', quantity: '18 компл.' },
      { name: 'Маскувальні сітки 6x4', quantity: '6 шт.' },
    ],
    checklist: [
      { label: 'Маршрут погоджено', state: 'Готово', done: true },
      { label: 'Акт передачі', state: 'Підписано', done: true },
      { label: 'Фото передачі', state: 'Потрібно додати', done: false },
      { label: 'Звіт', state: 'Без фото не завершено', done: false },
    ],
    notes: 'Потрібно отримати фото від штабу або водія для закриття звіту.',
  },
  {
    id: 'TR-2026-043',
    route: 'Дніпро - Запоріжжя - Оріхів',
    recipient: "Підрозділ радіозв'язку",
    driver: 'Сергій Романенко / пікап L200',
    transferDate: '2026-06-18',
    status: 'Передано',
    statusTone: 'transferred',
    act: 'ACT-2026-043.pdf',
    actTone: 'complete',
    photo: '5 фото завантажено',
    photoTone: 'complete',
    requestId: 'REQ-2026-031',
    warehouseId: 'WH-DRN-001',
    reportId: 'REP-2026-012',
    manifest: [
      { name: 'FPV комплекти 7"', quantity: '8 компл.' },
      { name: 'Акумулятори та антени', quantity: '8 наборів' },
    ],
    checklist: [
      { label: 'Маршрут погоджено', state: 'Готово', done: true },
      { label: 'Акт передачі', state: 'Підписано', done: true },
      { label: 'Фото передачі', state: 'Завантажено', done: true },
      { label: 'Звіт', state: 'Опубліковано', done: true },
    ],
    notes: 'Партію закрито, залишок FPV комплектів повернувся у вільний склад.',
  },
  {
    id: 'TR-2026-054',
    route: 'Львів - Київ - Чернігів',
    recipient: 'Чернігівський центр підтримки ВПО',
    driver: 'Марія Савчук / волонтер',
    transferDate: '2026-06-29',
    status: 'Заплановано',
    statusTone: 'planned',
    act: 'Акт не створено',
    actTone: 'missing',
    photo: 'Очікується після передачі',
    photoTone: 'partial',
    requestId: 'REQ-2026-048',
    warehouseId: 'WH-FOOD-027, WH-CND-006',
    reportId: 'REP-2026-021',
    manifest: [
      { name: 'Продуктові набори', quantity: '20 наборів' },
      { name: 'Окопні свічки', quantity: '60 шт.' },
    ],
    checklist: [
      { label: 'Маршрут погоджено', state: 'Уточнюється час', done: false },
      { label: 'Акт передачі', state: 'Потрібно створити', done: false },
      { label: 'Фото передачі', state: 'Після вручення', done: false },
      { label: 'Звіт', state: 'Очікує дані', done: false },
    ],
    notes: 'Підтвердити слот отримувача до кінця дня 2026-06-27.',
  },
];

function getFileBadgeClass(tone) {
  return styles[`file-${tone}`] || styles['file-partial'];
}

function LogisticsTransfersPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [documentFilter, setDocumentFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(transferRecords[0].id);

  const filteredTransfers = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return transferRecords.filter((transfer) => {
      const matchesStatus =
        statusFilter === 'all' || transfer.statusTone === statusFilter;
      const matchesDocuments =
        documentFilter === 'all' ||
        (documentFilter === 'missingAct' && transfer.actTone === 'missing') ||
        (documentFilter === 'missingPhoto' &&
          transfer.photoTone === 'missing') ||
        (documentFilter === 'reportReady' &&
          transfer.actTone === 'complete' &&
          transfer.photoTone === 'complete');
      const matchesSearch =
        !normalizedSearch ||
        [
          transfer.id,
          transfer.route,
          transfer.recipient,
          transfer.driver,
          transfer.status,
          transfer.requestId,
          transfer.warehouseId,
          transfer.reportId,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);

      return matchesStatus && matchesDocuments && matchesSearch;
    });
  }, [documentFilter, search, statusFilter]);

  const selectedTransfer =
    filteredTransfers.find((transfer) => transfer.id === selectedId) ||
    filteredTransfers[0] ||
    transferRecords[0];

  const totals = useMemo(() => {
    const planned = transferRecords.filter(
      (transfer) => transfer.statusTone === 'planned',
    ).length;
    const transferred = transferRecords.filter(
      (transfer) => transfer.statusTone === 'transferred',
    ).length;
    const needsReport = transferRecords.filter(
      (transfer) => transfer.statusTone === 'report',
    ).length;
    const missingFiles = transferRecords.filter(
      (transfer) =>
        transfer.actTone === 'missing' || transfer.photoTone === 'missing',
    ).length;

    return { planned, transferred, needsReport, missingFiles };
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Логістика / Передачі</p>
          <h1 className={styles.pageTitle}>Контроль передач допомоги</h1>
          <p className={styles.pageDescription}>
            Єдине місце, де видно маршрут, отримувача, відповідального
            водія або волонтера, дату, акт, фото та зв'язок із заявкою,
            складом і звітом.
          </p>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.primaryButton} type="button">
            Додати передачу
          </button>
          <button
            className={styles.secondaryButton}
            onClick={() => {
              setDocumentFilter('missingAct');
              setStatusFilter('all');
            }}
            type="button"
          >
            Список без актів
          </button>
        </div>
      </header>

      <section className={styles.summaryGrid} aria-label="Підсумок передач">
        <article className={styles.summaryCard}>
          <span>Заплановано</span>
          <strong>{totals.planned}</strong>
          <small>Передачі, де треба проконтролювати виїзд і документи</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Передано</span>
          <strong>{totals.transferred}</strong>
          <small>Закриті факти передачі з актом і фото</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Дозавантажити звіт</span>
          <strong>{totals.needsReport}</strong>
          <small>Є передача, але бракує матеріалів для повного звіту</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Бракує файлів</span>
          <strong>{totals.missingFiles}</strong>
          <small>Потрібно додати акт або фото, щоб не втратити контроль</small>
        </article>
      </section>

      <section className={styles.workspaceGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>Передачі</h2>
              <p className={styles.panelText}>
                Знайдено: {filteredTransfers.length} з {transferRecords.length}
              </p>
            </div>

            <button
              className={styles.smallButton}
              onClick={() => setStatusFilter('report')}
              type="button"
            >
              Нагадати про звіти
            </button>
          </div>

          <div className={styles.toolbar}>
            <input
              aria-label="Пошук передач"
              className={styles.searchInput}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Пошук за маршрутом, отримувачем, водієм або ID"
              type="search"
              value={search}
            />

            <select
              aria-label="Фільтр за статусом"
              className={styles.filterSelect}
              onChange={(event) => setStatusFilter(event.target.value)}
              value={statusFilter}
            >
              <option value="all">Усі статуси</option>
              <option value="planned">Заплановано</option>
              <option value="transferred">Передано</option>
              <option value="report">Потрібно дозавантажити звіт</option>
            </select>

            <select
              aria-label="Фільтр документів"
              className={styles.filterSelect}
              onChange={(event) => setDocumentFilter(event.target.value)}
              value={documentFilter}
            >
              <option value="all">Усі документи</option>
              <option value="missingAct">Без акта</option>
              <option value="missingPhoto">Без фото</option>
              <option value="reportReady">Готові до звіту</option>
            </select>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Передача</th>
                  <th>Маршрут</th>
                  <th>Отримувач</th>
                  <th>Водій / волонтер</th>
                  <th>Дата</th>
                  <th>Статус</th>
                  <th>Акт</th>
                  <th>Фото</th>
                  <th>Зв'язки</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransfers.map((transfer) => (
                  <tr
                    className={
                      transfer.id === selectedTransfer.id ? styles.activeRow : ''
                    }
                    key={transfer.id}
                    onClick={() => setSelectedId(transfer.id)}
                  >
                    <td>
                      <span className={styles.mainCell}>
                        <strong>{transfer.id}</strong>
                        <span>{transfer.manifest.length} позиції в передачі</span>
                      </span>
                    </td>
                    <td>{transfer.route}</td>
                    <td>{transfer.recipient}</td>
                    <td>{transfer.driver}</td>
                    <td className={styles.nowrap}>{transfer.transferDate}</td>
                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          styles[`status-${transfer.statusTone}`]
                        }`}
                      >
                        {transfer.status}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.fileBadge} ${getFileBadgeClass(
                          transfer.actTone,
                        )}`}
                      >
                        {transfer.act}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.fileBadge} ${getFileBadgeClass(
                          transfer.photoTone,
                        )}`}
                      >
                        {transfer.photo}
                      </span>
                    </td>
                    <td>
                      <span className={styles.mutedCell}>
                        {transfer.requestId}
                        <br />
                        {transfer.reportId}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredTransfers.length === 0 && (
            <div className={styles.emptyState}>
              За цими фільтрами передач не знайдено.
            </div>
          )}
        </article>

        <aside className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div>
              <span className={styles.detailCode}>{selectedTransfer.id}</span>
              <h2>{selectedTransfer.recipient}</h2>
              <p>{selectedTransfer.route}</p>
            </div>

            <span
              className={`${styles.statusBadge} ${
                styles[`status-${selectedTransfer.statusTone}`]
              }`}
            >
              {selectedTransfer.status}
            </span>
          </div>

          <section className={styles.detailSection}>
            <h3>Хто і коли передає</h3>
            <dl className={styles.infoList}>
              <div>
                <dt>Дата передачі</dt>
                <dd>{selectedTransfer.transferDate}</dd>
              </div>
              <div>
                <dt>Водій або волонтер</dt>
                <dd>{selectedTransfer.driver}</dd>
              </div>
              <div>
                <dt>Акт</dt>
                <dd>{selectedTransfer.act}</dd>
              </div>
              <div>
                <dt>Фото</dt>
                <dd>{selectedTransfer.photo}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.detailSection}>
            <h3>Що передається</h3>
            <div className={styles.manifestList}>
              {selectedTransfer.manifest.map((item) => (
                <div className={styles.manifestItem} key={item.name}>
                  <strong>{item.name}</strong>
                  <span>{item.quantity}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.detailSection}>
            <h3>Контроль документів</h3>
            <ul className={styles.checkList}>
              {selectedTransfer.checklist.map((item) => (
                <li key={item.label}>
                  <span
                    className={`${styles.checkDot} ${
                      item.done ? '' : styles.checkDotWarning
                    }`}
                    aria-hidden="true"
                  />
                  <strong>{item.label}</strong>
                  <span>{item.state}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.detailSection}>
            <h3>Зв'язки</h3>
            <ul className={styles.linkList}>
              <li>
                <span>Заявка</span>
                <span className={styles.linkBadge}>{selectedTransfer.requestId}</span>
              </li>
              <li>
                <span>Склад</span>
                <span className={styles.linkBadge}>{selectedTransfer.warehouseId}</span>
              </li>
              <li>
                <span>Звіт</span>
                <span className={styles.linkBadge}>{selectedTransfer.reportId}</span>
              </li>
            </ul>
          </section>

          <section className={styles.detailSection}>
            <h3>Нотатка</h3>
            <p className={styles.panelText}>{selectedTransfer.notes}</p>
          </section>
        </aside>
      </section>
    </main>
  );
}

export default LogisticsTransfersPage;
