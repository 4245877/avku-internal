import { useMemo, useState } from 'react';
import styles from './AidOperationsPage.module.css';

const categories = [
  'Дрони',
  'Генератори',
  'Продукти',
  'Медикаменти',
  'Сітки',
  'Свічки',
  'Одяг',
];

const inventoryItems = [
  {
    id: 'WH-DRN-001',
    name: 'FPV комплекти 7"',
    category: 'Дрони',
    quantity: 12,
    unit: 'компл.',
    condition: 'Нові, перевірені',
    location: 'Київ, склад A / стелаж 2',
    reservedFor: '93 ОМБр, заявка REQ-2026-031',
    availableNow: 4,
    status: 'Частково доступно',
    statusTone: 'progress',
    movement: [
      {
        date: '2026-06-18',
        title: 'Надходження на склад',
        meta: '+12 комплектів від партнерів, прийняв Олександр',
      },
      {
        date: '2026-06-20',
        title: 'Резерв під заявку',
        meta: '8 комплектів зарезервовано для 93 ОМБр',
      },
      {
        date: '2026-06-22',
        title: 'Перевірка комплектації',
        meta: 'Акумулятори та антени підтверджені',
      },
    ],
  },
  {
    id: 'WH-GEN-014',
    name: 'Генератори 3 кВт',
    category: 'Генератори',
    quantity: 6,
    unit: 'шт.',
    condition: 'Після сервісу, готові',
    location: 'Львів, склад B / зона техніки',
    reservedFor: 'Немає резерву',
    availableNow: 6,
    status: 'Можна видати',
    statusTone: 'ready',
    movement: [
      {
        date: '2026-06-12',
        title: 'Закупівля',
        meta: '+6 шт. за партнерським рахунком',
      },
      {
        date: '2026-06-14',
        title: 'Сервісна перевірка',
        meta: 'Мастило, запуск, навантаження - без зауважень',
      },
    ],
  },
  {
    id: 'WH-FOOD-027',
    name: 'Продуктові набори',
    category: 'Продукти',
    quantity: 80,
    unit: 'наборів',
    condition: 'Термін придатності до 2027-01',
    location: 'Київ, склад A / суха зона',
    reservedFor: 'Центр ВПО Харків, заявка REQ-2026-044',
    availableNow: 35,
    status: 'Частково доступно',
    statusTone: 'progress',
    movement: [
      {
        date: '2026-06-10',
        title: 'Надходження',
        meta: '+100 наборів від волонтерської групи',
      },
      {
        date: '2026-06-16',
        title: 'Видача',
        meta: '-20 наборів для сімей ВПО',
      },
      {
        date: '2026-06-24',
        title: 'Резерв',
        meta: '45 наборів під маршрут TR-2026-052',
      },
    ],
  },
  {
    id: 'WH-MED-009',
    name: 'Аптечки тактичні',
    category: 'Медикаменти',
    quantity: 24,
    unit: 'шт.',
    condition: 'Потребують доукомплектації турнікетами',
    location: 'Київ, склад A / медична шафа',
    reservedFor: 'Медики Сумського напрямку, REQ-2026-039',
    availableNow: 0,
    status: 'Потрібна перевірка',
    statusTone: 'warning',
    movement: [
      {
        date: '2026-06-07',
        title: 'Приймання',
        meta: '+24 аптечки без частини вкладень',
      },
      {
        date: '2026-06-11',
        title: 'Інвентаризація',
        meta: 'Не вистачає 24 турнікетів та 12 бандажів',
      },
      {
        date: '2026-06-21',
        title: 'Резерв',
        meta: 'Після доукомплектації передати медикам',
      },
    ],
  },
  {
    id: 'WH-NET-018',
    name: 'Маскувальні сітки 6x4',
    category: 'Сітки',
    quantity: 18,
    unit: 'шт.',
    condition: 'Готові, упаковані',
    location: 'Дніпро, партнерський склад / зона видачі',
    reservedFor: 'Немає резерву',
    availableNow: 18,
    status: 'Можна видати',
    statusTone: 'ready',
    movement: [
      {
        date: '2026-06-13',
        title: 'Передано від майстерні',
        meta: '+18 сіток, маркування за розміром',
      },
      {
        date: '2026-06-15',
        title: 'Фотофіксація',
        meta: 'Додано фото партії для звіту',
      },
    ],
  },
  {
    id: 'WH-CND-006',
    name: 'Окопні свічки',
    category: 'Свічки',
    quantity: 240,
    unit: 'шт.',
    condition: 'Готові до відвантаження',
    location: 'Львів, склад B / коробки C4-C7',
    reservedFor: 'Бахмутський напрямок, REQ-2026-047',
    availableNow: 120,
    status: 'Частково доступно',
    statusTone: 'progress',
    movement: [
      {
        date: '2026-06-05',
        title: 'Виробництво',
        meta: '+240 шт. від локальної майстерні',
      },
      {
        date: '2026-06-19',
        title: 'Резерв',
        meta: '120 шт. під найближчу передачу',
      },
    ],
  },
  {
    id: 'WH-CLT-033',
    name: 'Термобілизна, мікс розмірів',
    category: 'Одяг',
    quantity: 46,
    unit: 'компл.',
    condition: 'Новий одяг, розмірна сітка в описі',
    location: 'Київ, склад A / стелаж 5',
    reservedFor: 'Немає резерву',
    availableNow: 46,
    status: 'Можна видати',
    statusTone: 'ready',
    movement: [
      {
        date: '2026-06-09',
        title: 'Надходження',
        meta: '+50 комплектів від донорів',
      },
      {
        date: '2026-06-17',
        title: 'Видача',
        meta: '-4 комплекти для індивідуальної заявки',
      },
    ],
  },
];

function getAvailabilityLabel(item) {
  if (item.availableNow <= 0) {
    return 'Немає для негайної видачі';
  }

  if (item.availableNow === item.quantity) {
    return 'Можна видати все';
  }

  return `Можна видати ${item.availableNow} ${item.unit}`;
}

function WarehouseAidPage() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(inventoryItems[0].id);

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return inventoryItems.filter((item) => {
      const matchesCategory =
        categoryFilter === 'all' || item.category === categoryFilter;
      const matchesAvailability =
        availabilityFilter === 'all' ||
        (availabilityFilter === 'now' && item.availableNow > 0) ||
        (availabilityFilter === 'reserved' &&
          item.reservedFor !== 'Немає резерву') ||
        (availabilityFilter === 'check' && item.statusTone === 'warning');
      const matchesSearch =
        !normalizedSearch ||
        [
          item.id,
          item.name,
          item.category,
          item.condition,
          item.location,
          item.reservedFor,
          item.status,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);

      return matchesCategory && matchesAvailability && matchesSearch;
    });
  }, [availabilityFilter, categoryFilter, search]);

  const selectedItem =
    filteredItems.find((item) => item.id === selectedId) ||
    filteredItems[0] ||
    inventoryItems[0];

  const totals = useMemo(() => {
    const totalQuantity = inventoryItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const availableNow = inventoryItems.reduce(
      (sum, item) => sum + item.availableNow,
      0,
    );
    const reservedItems = inventoryItems.filter(
      (item) => item.reservedFor !== 'Немає резерву',
    ).length;
    const needsCheck = inventoryItems.filter(
      (item) => item.statusTone === 'warning',
    ).length;

    return { totalQuantity, availableNow, reservedItems, needsCheck };
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Склад / Матеріальна допомога</p>
          <h1 className={styles.pageTitle}>Наявність допомоги</h1>
          <p className={styles.pageDescription}>
            Оперативний зріз складу: що вже є, де лежить, кому зарезервовано і
            що команда може видати без нового збору.
          </p>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.primaryButton} type="button">
            Додати позицію
          </button>
          <button className={styles.secondaryButton} type="button">
            Експорт залишків
          </button>
        </div>
      </header>

      <section className={styles.summaryGrid} aria-label="Підсумок складу">
        <article className={styles.summaryCard}>
          <span>Усього одиниць</span>
          <strong>{totals.totalQuantity}</strong>
          <small>Сумарно за всіма категоріями матеріальної допомоги</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Можна видати зараз</span>
          <strong>{totals.availableNow}</strong>
          <small>Без додаткової закупівлі або перевірки</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Є резерв</span>
          <strong>{totals.reservedItems}</strong>
          <small>Позиції вже прив'язані до заявок або отримувачів</small>
        </article>

        <article className={styles.summaryCard}>
          <span>Потребують уваги</span>
          <strong>{totals.needsCheck}</strong>
          <small>Не можна видавати без доукомплектації або перевірки</small>
        </article>
      </section>

      <section className={styles.workspaceGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>Позиції на складі</h2>
              <p className={styles.panelText}>
                Знайдено: {filteredItems.length} з {inventoryItems.length}
              </p>
            </div>

            <button className={styles.smallButton} type="button">
              Оновити
            </button>
          </div>

          <div className={styles.toolbar}>
            <input
              aria-label="Пошук по складу"
              className={styles.searchInput}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Пошук за назвою, місцем, резервом або ID"
              type="search"
              value={search}
            />

            <select
              aria-label="Фільтр за категорією"
              className={styles.filterSelect}
              onChange={(event) => setCategoryFilter(event.target.value)}
              value={categoryFilter}
            >
              <option value="all">Усі категорії</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <select
              aria-label="Фільтр за доступністю"
              className={styles.filterSelect}
              onChange={(event) => setAvailabilityFilter(event.target.value)}
              value={availabilityFilter}
            >
              <option value="all">Уся доступність</option>
              <option value="now">Можна видати зараз</option>
              <option value="reserved">Зарезервовано</option>
              <option value="check">Потрібна перевірка</option>
            </select>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Позиція</th>
                  <th>Категорія</th>
                  <th>Кількість</th>
                  <th>Стан</th>
                  <th>Місце зберігання</th>
                  <th>Резерв</th>
                  <th>Видати зараз</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr
                    className={
                      item.id === selectedItem.id ? styles.activeRow : ''
                    }
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <td>
                      <span className={styles.mainCell}>
                        <strong>{item.name}</strong>
                        <span>{item.id}</span>
                      </span>
                    </td>
                    <td>
                      <span className={styles.categoryBadge}>
                        {item.category}
                      </span>
                    </td>
                    <td className={styles.nowrap}>
                      {item.quantity} {item.unit}
                    </td>
                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          styles[`status-${item.statusTone}`]
                        }`}
                      >
                        {item.status}
                      </span>
                      <div className={styles.mutedCell}>{item.condition}</div>
                    </td>
                    <td>{item.location}</td>
                    <td>{item.reservedFor}</td>
                    <td>
                      <span className={styles.availability}>
                        <strong>
                          {item.availableNow} {item.unit}
                        </strong>
                        <span>{getAvailabilityLabel(item)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredItems.length === 0 && (
            <div className={styles.emptyState}>
              За цими фільтрами позицій не знайдено.
            </div>
          )}
        </article>

        <aside className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div>
              <span className={styles.detailCode}>{selectedItem.id}</span>
              <h2>{selectedItem.name}</h2>
              <p>{selectedItem.category}</p>
            </div>

            <span
              className={`${styles.statusBadge} ${
                styles[`status-${selectedItem.statusTone}`]
              }`}
            >
              {selectedItem.status}
            </span>
          </div>

          <section className={styles.detailSection}>
            <h3>Швидка видача</h3>
            <dl className={styles.infoList}>
              <div>
                <dt>Доступно зараз</dt>
                <dd>
                  {selectedItem.availableNow} {selectedItem.unit}
                </dd>
              </div>
              <div>
                <dt>Усього на залишку</dt>
                <dd>
                  {selectedItem.quantity} {selectedItem.unit}
                </dd>
              </div>
              <div>
                <dt>Резерв</dt>
                <dd>{selectedItem.reservedFor}</dd>
              </div>
              <div>
                <dt>Стан</dt>
                <dd>{selectedItem.condition}</dd>
              </div>
              <div>
                <dt>Місце</dt>
                <dd>{selectedItem.location}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.detailSection}>
            <h3>Історія руху</h3>
            <div className={styles.timeline}>
              {selectedItem.movement.map((event) => (
                <article className={styles.timelineItem} key={event.title}>
                  <time dateTime={event.date}>{event.date}</time>
                  <div className={styles.timelineBody}>
                    <strong>{event.title}</strong>
                    <span>{event.meta}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

export default WarehouseAidPage;
