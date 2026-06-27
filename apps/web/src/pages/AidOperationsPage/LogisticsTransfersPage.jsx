import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addTransferEvent,
  createTransfer,
  deleteTransfer,
  downloadBlob,
  downloadTransfers,
  fetchTransfers,
  updateTransfer,
} from '../../features/logistics/logisticsApi.js';
import {
  buildChecklist,
  buildTransferPayload,
  filterTransfers,
  getActBadge,
  getEventTypeLabel,
  getPhotoBadge,
  getStatusBadge,
  summarizeTransfers,
  upsertTransfer,
} from '../../features/logistics/logisticsUtils.js';
import TransferDialog from './components/TransferDialog.jsx';
import TransferUpdateDialog from './components/TransferUpdateDialog.jsx';
import DeleteTransferDialog from './components/DeleteTransferDialog.jsx';
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

function getFileBadgeClass(tone) {
  return styles[`file-${tone}`] || styles['file-partial'];
}

function LogisticsTransfersPage() {
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [documentFilter, setDocumentFilter] = useState('all');
  const [selectedId, setSelectedId] = useState('');

  const [isExporting, setIsExporting] = useState(false);
  const [transferDialog, setTransferDialog] = useState(null);
  const [isSavingTransfer, setIsSavingTransfer] = useState(false);
  const [updateTarget, setUpdateTarget] = useState(null);
  const [isSavingUpdate, setIsSavingUpdate] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const showNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const loadTransfers = useCallback(async () => {
    setLoading(true);

    try {
      const records = await fetchTransfers();

      setTransfers(records);
      setLoadError('');

      return records;
    } catch (error) {
      const message = getErrorMessage(
        error,
        'Не вдалося завантажити передачі.',
      );

      setLoadError(message);
      showNotice('error', message);

      return null;
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    loadTransfers();
  }, [loadTransfers]);

  const filteredTransfers = useMemo(
    () =>
      filterTransfers(transfers, {
        search,
        status: statusFilter,
        documents: documentFilter,
      }),
    [documentFilter, search, statusFilter, transfers],
  );

  const selectedTransfer = useMemo(() => {
    if (filteredTransfers.length === 0) {
      return null;
    }

    return (
      filteredTransfers.find((transfer) => transfer.id === selectedId) ??
      filteredTransfers[0]
    );
  }, [filteredTransfers, selectedId]);

  const totals = useMemo(() => summarizeTransfers(transfers), [transfers]);

  const isBusy =
    loading || isSavingTransfer || isSavingUpdate || isDeleting || isExporting;

  const handleRefresh = useCallback(async () => {
    if (isBusy) {
      return;
    }

    const records = await loadTransfers();

    if (records) {
      showNotice('info', 'Дані передач оновлено.');
    }
  }, [isBusy, loadTransfers, showNotice]);

  const handleExport = useCallback(async () => {
    if (isBusy) {
      return;
    }

    setIsExporting(true);

    try {
      const blob = await downloadTransfers();

      downloadBlob(blob, 'logistics-transfers.csv');
      showNotice('success', 'Експорт передач сформовано.');
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
    setTransferDialog({ mode: 'create', transfer: null });
  }, [clearNotice, isBusy]);

  const openEditDialog = useCallback(
    (transfer) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setTransferDialog({ mode: 'edit', transfer });
    },
    [clearNotice, isBusy],
  );

  const closeTransferDialog = useCallback(() => {
    if (isSavingTransfer) {
      return;
    }

    setTransferDialog(null);
  }, [isSavingTransfer]);

  const submitTransferDialog = useCallback(
    async (form) => {
      setIsSavingTransfer(true);

      try {
        const payload = buildTransferPayload(form);
        const isEdit = Boolean(transferDialog?.transfer);
        const savedTransfer = isEdit
          ? await updateTransfer(transferDialog.transfer.id, payload)
          : await createTransfer(payload);

        setTransfers((current) => upsertTransfer(current, savedTransfer));
        setSelectedId(savedTransfer.id);
        setTransferDialog(null);
        showNotice(
          'success',
          isEdit ? 'Передачу оновлено.' : 'Передачу додано.',
        );
      } catch (error) {
        showNotice(
          'error',
          getErrorMessage(error, 'Не вдалося зберегти передачу.'),
        );
      } finally {
        setIsSavingTransfer(false);
      }
    },
    [showNotice, transferDialog],
  );

  const openUpdateDialog = useCallback(
    (transfer) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setUpdateTarget(transfer);
    },
    [clearNotice, isBusy],
  );

  const closeUpdateDialog = useCallback(() => {
    if (isSavingUpdate) {
      return;
    }

    setUpdateTarget(null);
  }, [isSavingUpdate]);

  const submitUpdate = useCallback(
    async (payload) => {
      if (!updateTarget) {
        return;
      }

      setIsSavingUpdate(true);

      try {
        const updatedTransfer = await addTransferEvent(
          updateTarget.id,
          payload,
        );

        setTransfers((current) => upsertTransfer(current, updatedTransfer));
        setSelectedId(updatedTransfer.id);
        setUpdateTarget(null);
        showNotice('success', 'Запис у передачі оновлено.');
      } catch (error) {
        showNotice(
          'error',
          getErrorMessage(error, 'Не вдалося зберегти оновлення.'),
        );
      } finally {
        setIsSavingUpdate(false);
      }
    },
    [showNotice, updateTarget],
  );

  const requestDelete = useCallback(
    (transfer) => {
      if (isBusy) {
        return;
      }

      clearNotice();
      setDeleteCandidate(transfer);
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
      await deleteTransfer(deleteCandidate.id);

      setTransfers((current) =>
        current.filter((transfer) => transfer.id !== deleteCandidate.id),
      );
      setDeleteCandidate(null);
      showNotice('success', 'Передачу видалено.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося видалити передачу.'),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [deleteCandidate, showNotice]);

  const selectedStatus = selectedTransfer
    ? getStatusBadge(selectedTransfer)
    : null;
  const selectedChecklist = selectedTransfer
    ? buildChecklist(selectedTransfer)
    : [];
  const noticeClassName = notice
    ? [styles.notice, styles[NOTICE_STYLE_BY_TYPE[notice.type]]]
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <main className={styles.page} aria-busy={loading}>
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
          <button
            className={styles.primaryButton}
            type="button"
            onClick={openCreateDialog}
            disabled={isBusy}
          >
            Додати передачу
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={handleExport}
            disabled={isBusy || transfers.length === 0}
          >
            {isExporting ? 'Експорт…' : 'Експорт передач'}
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
              <h2 className={styles.panelTitle}>Передачі</h2>
              <p className={styles.panelText}>
                Знайдено: {filteredTransfers.length} з {transfers.length}
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
                {filteredTransfers.map((transfer) => {
                  const status = getStatusBadge(transfer);
                  const act = getActBadge(transfer);
                  const photo = getPhotoBadge(transfer);

                  return (
                    <tr
                      className={
                        selectedTransfer && transfer.id === selectedTransfer.id
                          ? styles.activeRow
                          : ''
                      }
                      key={transfer.id}
                      onClick={() => setSelectedId(transfer.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(transfer.id);
                        }
                      }}
                      tabIndex={0}
                      aria-current={
                        selectedTransfer && transfer.id === selectedTransfer.id
                          ? 'true'
                          : undefined
                      }
                      aria-label={`Передача ${transfer.code}, ${transfer.recipient}`}
                    >
                      <td data-label="Передача">
                        <span className={styles.mainCell}>
                          <strong>{transfer.code}</strong>
                          <span>
                            {transfer.manifest.length} позиції в передачі
                          </span>
                        </span>
                      </td>
                      <td data-label="Маршрут">{transfer.route}</td>
                      <td data-label="Отримувач">{transfer.recipient}</td>
                      <td data-label="Водій / волонтер">{transfer.driver}</td>
                      <td className={styles.nowrap} data-label="Дата">
                        {transfer.transferDate}
                      </td>
                      <td data-label="Статус">
                        <span
                          className={`${styles.statusBadge} ${
                            styles[`status-${status.tone}`]
                          }`}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td data-label="Акт">
                        <span
                          className={`${styles.fileBadge} ${getFileBadgeClass(
                            act.tone,
                          )}`}
                        >
                          {act.label}
                        </span>
                      </td>
                      <td data-label="Фото">
                        <span
                          className={`${styles.fileBadge} ${getFileBadgeClass(
                            photo.tone,
                          )}`}
                        >
                          {photo.label}
                        </span>
                      </td>
                      <td data-label="Зв'язки">
                        <span className={styles.mutedCell}>
                          {transfer.requestId || '—'}
                          <br />
                          {transfer.reportId || '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!loading && filteredTransfers.length === 0 && (
            <div className={styles.emptyState}>
              {loadError
                ? loadError
                : transfers.length === 0
                  ? 'Передач ще немає. Додайте першу передачу.'
                  : 'За цими фільтрами передач не знайдено.'}
            </div>
          )}
        </article>

        <aside className={styles.detailPanel}>
          {selectedTransfer ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <span className={styles.detailCode}>
                    {selectedTransfer.code}
                  </span>
                  <h2>{selectedTransfer.recipient}</h2>
                  <p>{selectedTransfer.route}</p>
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
                  onClick={() => openUpdateDialog(selectedTransfer)}
                  disabled={isBusy}
                >
                  Оновити
                </button>
                <button
                  className={styles.smallButton}
                  type="button"
                  onClick={() => openEditDialog(selectedTransfer)}
                  disabled={isBusy}
                >
                  Редагувати
                </button>
                <button
                  className={styles.smallDangerButton}
                  type="button"
                  onClick={() => requestDelete(selectedTransfer)}
                  disabled={isBusy}
                >
                  Видалити
                </button>
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
                    <dd>{getActBadge(selectedTransfer).label}</dd>
                  </div>
                  <div>
                    <dt>Фото</dt>
                    <dd>{getPhotoBadge(selectedTransfer).label}</dd>
                  </div>
                </dl>
              </section>

              <section className={styles.detailSection}>
                <h3>Що передається</h3>
                {selectedTransfer.manifest.length > 0 ? (
                  <div className={styles.manifestList}>
                    {selectedTransfer.manifest.map((item, index) => (
                      <div
                        className={styles.manifestItem}
                        // eslint-disable-next-line react/no-array-index-key
                        key={`${item.name}-${index}`}
                      >
                        <strong>{item.name}</strong>
                        <span>{item.quantity || '—'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.panelText}>Склад передачі не вказано.</p>
                )}
              </section>

              <section className={styles.detailSection}>
                <h3>Контроль документів</h3>
                <ul className={styles.checkList}>
                  {selectedChecklist.map((item) => (
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
                    <span className={styles.linkBadge}>
                      {selectedTransfer.requestId || '—'}
                    </span>
                  </li>
                  <li>
                    <span>Склад</span>
                    <span className={styles.linkBadge}>
                      {selectedTransfer.warehouseId || '—'}
                    </span>
                  </li>
                  <li>
                    <span>Звіт</span>
                    <span className={styles.linkBadge}>
                      {selectedTransfer.reportId || '—'}
                    </span>
                  </li>
                </ul>
              </section>

              {selectedTransfer.notes ? (
                <section className={styles.detailSection}>
                  <h3>Нотатка</h3>
                  <p className={styles.panelText}>{selectedTransfer.notes}</p>
                </section>
              ) : null}

              <section className={styles.detailSection}>
                <h3>Історія передачі</h3>
                {selectedTransfer.events.length > 0 ? (
                  <div className={styles.timeline}>
                    {[...selectedTransfer.events].reverse().map((event) => (
                      <article className={styles.timelineItem} key={event.id}>
                        <time dateTime={event.date}>{event.date}</time>
                        <div className={styles.timelineBody}>
                          <strong>
                            {event.title}
                            <span className={styles.timelineTag}>
                              {getEventTypeLabel(event.type)}
                            </span>
                          </strong>
                          {event.meta ? <span>{event.meta}</span> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className={styles.panelText}>Записів в історії ще немає.</p>
                )}
              </section>
            </>
          ) : (
            <div className={styles.emptyState}>
              {loading
                ? 'Завантаження передач…'
                : 'Оберіть передачу зі списку, щоб побачити деталі.'}
            </div>
          )}
        </aside>
      </section>

      <TransferDialog
        transfer={transferDialog?.transfer ?? null}
        isOpen={Boolean(transferDialog)}
        isSaving={isSavingTransfer}
        onClose={closeTransferDialog}
        onSubmit={submitTransferDialog}
      />

      <TransferUpdateDialog
        transfer={updateTarget}
        isOpen={Boolean(updateTarget)}
        isSaving={isSavingUpdate}
        onClose={closeUpdateDialog}
        onSubmit={submitUpdate}
      />

      <DeleteTransferDialog
        transfer={deleteCandidate}
        isDeleting={isDeleting}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </main>
  );
}

export default LogisticsTransfersPage;
