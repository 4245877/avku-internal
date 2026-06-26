import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addWarehouseMovement,
  createWarehouseItem,
  deleteWarehouseItem,
  downloadBlob,
  downloadWarehouseStock,
  fetchWarehouseItems,
  updateWarehouseItem,
} from '../../features/warehouse/warehouseApi.js';
import {
  WAREHOUSE_CATEGORIES,
  buildItemPayload,
  filterItems,
  getAvailabilityLabel,
  getItemStatus,
  getMovementTypeLabel,
  getReserveLabel,
  summarizeItems,
  upsertItem,
} from '../../features/warehouse/warehouseUtils.js';
import WarehouseItemDialog from './components/WarehouseItemDialog.jsx';
import WarehouseMovementDialog from './components/WarehouseMovementDialog.jsx';
import DeleteWarehouseItemDialog from './components/DeleteWarehouseItemDialog.jsx';
import styles from './AidOperationsPage.module.css';

const NOTICE_STYLE_BY_TYPE = {
  error: 'noticeError',
  info: 'noticeInfo',
  success: 'noticeSuccess',
  warning: 'noticeWarning',
};

function getErrorMessage(error, fallbackMessage) {
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

function WarehouseAidPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [availabilityFilter, setAvailabilityFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');

  const [isExporting, setIsExporting] = useState(false);
  const [itemDialog, setItemDialog] = useState(null);
  const [isSavingItem, setIsSavingItem] = useState(false);
  const [movementTarget, setMovementTarget] = useState(null);
  const [isSavingMovement, setIsSavingMovement] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const showNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);

    try {
      const records = await fetchWarehouseItems();

      setItems(records);
      setLoadError('');

      return records;
    } catch (error) {
      const message = getErrorMessage(
        error,
        'Не вдалося завантажити дані складу.',
      );

      setLoadError(message);
      showNotice('error', message);

      return null;
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const filteredItems = useMemo(
    () =>
      filterItems(items, {
        search,
        category: categoryFilter,
        availability: availabilityFilter,
      }),
    [availabilityFilter, categoryFilter, items, search],
  );

  const selectedItem = useMemo(() => {
    if (filteredItems.length === 0) {
      return null;
    }

    return (
      filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0]
    );
  }, [filteredItems, selectedId]);

  const totals = useMemo(() => summarizeItems(items), [items]);

  const isBusy =
    loading || isSavingItem || isSavingMovement || isDeleting || isExporting;

  const handleRefresh = useCallback(async () => {
    if (isBusy) {
      return;
    }

    const records = await loadItems();

    if (records) {
      showNotice('info', 'Дані складу оновлено.');
    }
  }, [isBusy, loadItems, showNotice]);

  const handleExport = useCallback(async () => {
    if (isBusy) {
      return;
    }

    setIsExporting(true);

    try {
      const blob = await downloadWarehouseStock();

      downloadBlob(blob, 'warehouse-stock.csv');
      showNotice('success', 'Експорт залишків сформовано.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося сформувати експорт.'),
      );
    } finally {
      setIsExporting(false);
    }
  }, [isBusy, showNotice]);

  const openCreateDialog = useCallback(() => {
    if (isBusy) {
      return;
    }

    clearNotice();
    setItemDialog({ mode: 'create', item: null });
  }, [clearNotice, isBusy]);

  const openEditDialog = useCallback(
    (item) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setItemDialog({ mode: 'edit', item });
    },
    [clearNotice, isBusy],
  );

  const closeItemDialog = useCallback(() => {
    if (isSavingItem) {
      return;
    }

    setItemDialog(null);
  }, [isSavingItem]);

  const submitItemDialog = useCallback(
    async (form) => {
      setIsSavingItem(true);

      try {
        const payload = buildItemPayload(form);
        const isEdit = Boolean(itemDialog?.item);
        const savedItem = isEdit
          ? await updateWarehouseItem(itemDialog.item.id, payload)
          : await createWarehouseItem(payload);

        setItems((current) => upsertItem(current, savedItem));
        setSelectedId(savedItem.id);
        setItemDialog(null);
        showNotice(
          'success',
          isEdit ? 'Позицію оновлено.' : 'Позицію додано на склад.',
        );
      } catch (error) {
        showNotice(
          'error',
          getErrorMessage(error, 'Не вдалося зберегти позицію.'),
        );
      } finally {
        setIsSavingItem(false);
      }
    },
    [itemDialog, showNotice],
  );

  const openMovementDialog = useCallback(
    (item) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setMovementTarget(item);
    },
    [clearNotice, isBusy],
  );

  const closeMovementDialog = useCallback(() => {
    if (isSavingMovement) {
      return;
    }

    setMovementTarget(null);
  }, [isSavingMovement]);

  const submitMovement = useCallback(
    async (payload) => {
      if (!movementTarget) {
        return;
      }

      setIsSavingMovement(true);

      try {
        const updatedItem = await addWarehouseMovement(
          movementTarget.id,
          payload,
        );

        setItems((current) => upsertItem(current, updatedItem));
        setSelectedId(updatedItem.id);
        setMovementTarget(null);
        showNotice('success', 'Рух по позиції записано.');
      } catch (error) {
        showNotice(
          'error',
          getErrorMessage(error, 'Не вдалося записати рух.'),
        );
      } finally {
        setIsSavingMovement(false);
      }
    },
    [movementTarget, showNotice],
  );

  const requestDelete = useCallback(
    (item) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setDeleteCandidate(item);
    },
    [clearNotice, isBusy],
  );

  const cancelDelete = useCallback(() => {
    if (isDeleting) {
      return;
    }

    setDeleteCandidate(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!deleteCandidate) {
      return;
    }

    setIsDeleting(true);

    try {
      await deleteWarehouseItem(deleteCandidate.id);

      setItems((current) =>
        current.filter((item) => item.id !== deleteCandidate.id),
      );
      setDeleteCandidate(null);
      showNotice('success', 'Позицію видалено зі складу.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося видалити позицію.'),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [deleteCandidate, showNotice]);

  const selectedStatus = selectedItem ? getItemStatus(selectedItem) : null;
  const noticeClassName = notice
    ? [styles.notice, styles[NOTICE_STYLE_BY_TYPE[notice.type]]]
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <main className={styles.page} aria-busy={loading}>
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
          <button
            className={styles.primaryButton}
            type="button"
            onClick={openCreateDialog}
            disabled={isBusy}
          >
            Додати позицію
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={handleExport}
            disabled={isBusy || items.length === 0}
          >
            {isExporting ? 'Експорт…' : 'Експорт залишків'}
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

      <div className={styles.noticeRegion} aria-live="polite" aria-atomic="true">
        {notice ? (
          <div
            className={noticeClassName}
            role={notice.type === 'error' ? 'alert' : 'status'}
          >
            <span>{notice.text}</span>
            <button
              className={styles.noticeCloseButton}
              type="button"
              onClick={clearNotice}
              aria-label="Закрити сповіщення"
            >
              Закрити
            </button>
          </div>
        ) : null}
      </div>

      <section className={styles.workspaceGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>Позиції на складі</h2>
              <p className={styles.panelText}>
                Знайдено: {filteredItems.length} з {items.length}
              </p>
            </div>

            <button
              className={styles.smallButton}
              type="button"
              onClick={handleRefresh}
              disabled={isBusy}
            >
              {loading ? 'Оновлення…' : 'Оновити'}
            </button>
          </div>

          <div className={styles.toolbar}>
            <input
              aria-label="Пошук по складу"
              className={styles.searchInput}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Пошук за назвою, місцем, резервом або кодом"
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
              {WAREHOUSE_CATEGORIES.map((category) => (
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
                {filteredItems.map((item) => {
                  const status = getItemStatus(item);

                  return (
                    <tr
                      className={
                        selectedItem && item.id === selectedItem.id
                          ? styles.activeRow
                          : ''
                      }
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <td>
                        <span className={styles.mainCell}>
                          <strong>{item.name}</strong>
                          <span>{item.code}</span>
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
                            styles[`status-${status.tone}`]
                          }`}
                        >
                          {status.label}
                        </span>
                        <div className={styles.mutedCell}>
                          {item.condition || '—'}
                        </div>
                      </td>
                      <td>{item.location || '—'}</td>
                      <td>{getReserveLabel(item)}</td>
                      <td>
                        <span className={styles.availability}>
                          <strong>
                            {item.availableNow} {item.unit}
                          </strong>
                          <span>{getAvailabilityLabel(item)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!loading && filteredItems.length === 0 && (
            <div className={styles.emptyState}>
              {loadError
                ? loadError
                : items.length === 0
                  ? 'Склад порожній. Додайте першу позицію.'
                  : 'За цими фільтрами позицій не знайдено.'}
            </div>
          )}
        </article>

        <aside className={styles.detailPanel}>
          {selectedItem ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <span className={styles.detailCode}>{selectedItem.code}</span>
                  <h2>{selectedItem.name}</h2>
                  <p>{selectedItem.category}</p>
                </div>

                <span
                  className={`${styles.statusBadge} ${
                    styles[`status-${selectedStatus.tone}`]
                  }`}
                >
                  {selectedStatus.label}
                </span>
              </div>

              <div className={styles.detailActions}>
                <button
                  className={styles.smallButton}
                  type="button"
                  onClick={() => openMovementDialog(selectedItem)}
                  disabled={isBusy}
                >
                  Рух
                </button>
                <button
                  className={styles.smallButton}
                  type="button"
                  onClick={() => openEditDialog(selectedItem)}
                  disabled={isBusy}
                >
                  Редагувати
                </button>
                <button
                  className={styles.smallDangerButton}
                  type="button"
                  onClick={() => requestDelete(selectedItem)}
                  disabled={isBusy}
                >
                  Видалити
                </button>
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
                    <dd>{getReserveLabel(selectedItem)}</dd>
                  </div>
                  <div>
                    <dt>Стан</dt>
                    <dd>{selectedItem.condition || '—'}</dd>
                  </div>
                  <div>
                    <dt>Місце</dt>
                    <dd>{selectedItem.location || '—'}</dd>
                  </div>
                </dl>
              </section>

              <section className={styles.detailSection}>
                <h3>Історія руху</h3>
                {selectedItem.movement.length > 0 ? (
                  <div className={styles.timeline}>
                    {[...selectedItem.movement]
                      .reverse()
                      .map((event) => (
                        <article className={styles.timelineItem} key={event.id}>
                          <time dateTime={event.date}>{event.date}</time>
                          <div className={styles.timelineBody}>
                            <strong>
                              {event.title}
                              <span className={styles.timelineTag}>
                                {getMovementTypeLabel(event.type)}
                              </span>
                            </strong>
                            {event.meta ? <span>{event.meta}</span> : null}
                          </div>
                        </article>
                      ))}
                  </div>
                ) : (
                  <p className={styles.panelText}>Записів руху ще немає.</p>
                )}
              </section>
            </>
          ) : (
            <div className={styles.emptyState}>
              {loading
                ? 'Завантаження складу…'
                : 'Оберіть позицію зі списку, щоб побачити деталі.'}
            </div>
          )}
        </aside>
      </section>

      <WarehouseItemDialog
        item={itemDialog?.item ?? null}
        isOpen={Boolean(itemDialog)}
        isSaving={isSavingItem}
        onClose={closeItemDialog}
        onSubmit={submitItemDialog}
      />

      <WarehouseMovementDialog
        item={movementTarget}
        isOpen={Boolean(movementTarget)}
        isSaving={isSavingMovement}
        onClose={closeMovementDialog}
        onSubmit={submitMovement}
      />

      <DeleteWarehouseItemDialog
        item={deleteCandidate}
        isDeleting={isDeleting}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </main>
  );
}

export default WarehouseAidPage;
