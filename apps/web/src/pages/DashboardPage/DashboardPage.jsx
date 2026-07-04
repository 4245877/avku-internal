import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Link } from 'react-router';

import styles from './DashboardPage.module.css';
import { exportAsJson, exportAsCsv } from '../../features/export/exportRecords';
import { fetchCertificates } from '../../features/certificates/certificateApi.js';
import { getCertificateStatus } from '../../features/certificates/certificateUtils.js';
import { fetchWarehouseItems } from '../../features/warehouse/warehouseApi.js';
import { getItemStatus } from '../../features/warehouse/warehouseUtils.js';
import { fetchTransfers } from '../../features/logistics/logisticsApi.js';
import {
  TRANSFER_STATUS_OPTIONS,
  getStatusBadge,
  summarizeTransfers,
} from '../../features/logistics/logisticsUtils.js';

const INITIAL_DASHBOARD_DATA = {
  certificates: [],
  warehouseItems: [],
  transfers: [],
};

const CERTIFICATE_STATUS_TONES = {
  active: 'published',
  soon: 'ready',
  expired: 'draft',
  muted: 'draft',
};

const WAREHOUSE_STATUS_TONES = {
  ready: 'published',
  progress: 'progress',
  warning: 'ready',
};

const TRANSFER_STATUS_TONES = {
  planned: 'progress',
  transferred: 'published',
  report: 'ready',
};

const quickActions = [
  { label: 'Перейти до посвідчень', path: '/certificates' },
  { label: 'Перевірити склад', path: '/warehouse-aid' },
  { label: 'Відкрити логістику', path: '/logistics-transfers' },
];

const DEFAULT_TRANSFER_STATUS = TRANSFER_STATUS_OPTIONS[0]?.value ?? 'planned';
const TRANSFER_STATUS_LABELS = new Map(
  TRANSFER_STATUS_OPTIONS.map((option) => [option.value, option.label]),
);

function getErrorMessage(
  error,
  fallbackMessage = 'Не вдалося завантажити дані dashboard.',
) {
  return error instanceof Error && error.message
    ? error.message
    : fallbackMessage;
}

function toRecordArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((record) => record && typeof record === 'object');
}

function toDateLabel(value) {
  return typeof value === 'string' && value.trim()
    ? value.slice(0, 10)
    : '—';
}

function toSortTime(value) {
  return Date.parse(value ?? '') || 0;
}

function getApiResultRecords(result, sourceLabel) {
  if (result.status === 'fulfilled') {
    if (Array.isArray(result.value)) {
      return {
        records: toRecordArray(result.value),
        error: '',
      };
    }

    return {
      records: [],
      error: `${sourceLabel}: API повернув не список.`,
    };
  }

  return {
    records: [],
    error: `${sourceLabel}: ${getErrorMessage(result.reason)}`,
  };
}

function getTransferStatusValue(transfer) {
  if (typeof transfer.status === 'string' && transfer.status.trim()) {
    return transfer.status.trim();
  }

  return DEFAULT_TRANSFER_STATUS;
}

function getTransferStatusLabel(status) {
  return TRANSFER_STATUS_LABELS.get(status) ?? `Невідомий статус: ${status}`;
}

function isLowStockItem(item) {
  return getItemStatus(item).tone === 'warning';
}

function createCertificateRecord(certificate, index) {
  const status = getCertificateStatus(certificate.validUntil);
  const recordId =
    certificate.certificateNumber ||
    certificate.id ||
    `certificate-${index + 1}`;

  return {
    key: `certificate-${recordId}-${index}`,
    id: recordId,
    type: 'Посвідчення',
    title: certificate.fullName || 'Без ПІБ',
    status: status.label,
    responsible: certificate.validUntil
      ? `Діє до ${certificate.validUntil}`
      : 'Термін не вказано',
    date: toDateLabel(certificate.updatedAt || certificate.createdAt),
    statusTone: CERTIFICATE_STATUS_TONES[status.tone] ?? 'draft',
    sortDate: certificate.updatedAt || certificate.createdAt || certificate.validUntil,
  };
}

function createWarehouseRecord(item, index) {
  const status = getItemStatus(item);
  const recordId = item.code || item.id || `warehouse-${index + 1}`;

  return {
    key: `warehouse-${recordId}-${index}`,
    id: recordId,
    type: 'Склад',
    title: item.name || 'Позиція без назви',
    status: status.label,
    responsible: item.location || item.reservedFor || 'Без привʼязки',
    date: toDateLabel(item.updatedAt || item.createdAt),
    statusTone: WAREHOUSE_STATUS_TONES[status.tone] ?? 'draft',
    sortDate: item.updatedAt || item.createdAt,
  };
}

function createTransferRecord(transfer, index) {
  const status = getStatusBadge(transfer);
  const statusValue = getTransferStatusValue(transfer);
  const isKnownStatus = TRANSFER_STATUS_LABELS.has(statusValue);
  const recordId = transfer.code || transfer.id || `transfer-${index + 1}`;
  const recipient = transfer.recipient || '';
  const route = transfer.route || '';

  return {
    key: `transfer-${recordId}-${index}`,
    id: recordId,
    type: 'Передача',
    title: recipient && route
      ? `${recipient}: ${route}`
      : recipient || route || 'Передача без маршруту',
    status: isKnownStatus ? status.label : getTransferStatusLabel(statusValue),
    responsible: transfer.driver || 'Водій не вказаний',
    date: toDateLabel(transfer.transferDate || transfer.updatedAt),
    statusTone: isKnownStatus
      ? TRANSFER_STATUS_TONES[status.tone] ?? 'draft'
      : 'draft',
    sortDate: transfer.updatedAt || transfer.transferDate || transfer.createdAt,
  };
}

function toExportRecords(records) {
  return records.map(({
    key,
    sortDate,
    ...record
  }) => record);
}

function DashboardPage() {
  const [search, setSearch] = useState('');
  const [dashboardData, setDashboardData] = useState(INITIAL_DASHBOARD_DATA);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState([]);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    setLoadErrors([]);

    const [
      certificatesResult,
      warehouseItemsResult,
      transfersResult,
    ] = await Promise.allSettled([
      fetchCertificates(),
      fetchWarehouseItems(),
      fetchTransfers(),
    ]);

    const certificatesData = getApiResultRecords(
      certificatesResult,
      'Посвідчення',
    );
    const warehouseItemsData = getApiResultRecords(
      warehouseItemsResult,
      'Склад',
    );
    const transfersData = getApiResultRecords(
      transfersResult,
      'Логістика',
    );

    setDashboardData({
      certificates: certificatesData.records,
      warehouseItems: warehouseItemsData.records,
      transfers: transfersData.records,
    });
    setLoadErrors([
      certificatesData.error,
      warehouseItemsData.error,
      transfersData.error,
    ].filter(Boolean));
    setLoading(false);
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const {
    certificates,
    warehouseItems,
    transfers,
  } = dashboardData;

  const metrics = useMemo(() => {
    const certificateStatuses = certificates.map((certificate) =>
      getCertificateStatus(certificate.validUntil),
    );
    const transferStatusCounts = transfers.reduce((counts, transfer) => {
      const status = getTransferStatusValue(transfer);

      return {
        ...counts,
        [status]: (counts[status] ?? 0) + 1,
      };
    }, {});
    const transferSummary = summarizeTransfers(transfers);

    return {
      totalCertificates: certificates.length,
      activeCertificates: certificateStatuses.filter((status) =>
        status.tone === 'active',
      ).length,
      expiringCertificates: certificateStatuses.filter((status) =>
        status.tone === 'soon',
      ).length,
      warehousePositions: warehouseItems.length,
      lowStockPositions: warehouseItems.filter(isLowStockItem).length,
      activeTransfers: transferSummary.planned + transferSummary.needsReport,
      transferStatusCounts,
    };
  }, [certificates, transfers, warehouseItems]);

  const summaryCards = useMemo(() => [
    {
      label: 'Посвідчення',
      value: metrics.totalCertificates,
      hint: 'Усі записи посвідчень з реєстру API',
    },
    {
      label: 'Дійсні посвідчення',
      value: metrics.activeCertificates,
      hint: 'Не прострочені та не входять до групи найближчого спливу',
    },
    {
      label: 'Спливають',
      value: metrics.expiringCertificates,
      hint: 'Позначені реєстром посвідчень як такі, що скоро спливають',
    },
    {
      label: 'Позиції складу',
      value: metrics.warehousePositions,
      hint: 'Номенклатура матеріальної допомоги на складі',
    },
    {
      label: 'Потребують уваги',
      value: metrics.lowStockPositions,
      hint: 'Позиції, які складський статус позначає як такі, що потребують уваги',
    },
    {
      label: 'Активні передачі',
      value: metrics.activeTransfers,
      hint: 'Передачі, які логістичний модуль рахує незакритими',
    },
  ], [metrics]);

  const transferStatusItems = useMemo(() =>
    [
      ...TRANSFER_STATUS_OPTIONS.map((option) => ({
        label: option.label,
        value: metrics.transferStatusCounts[option.value] ?? 0,
      })),
      ...Object.entries(metrics.transferStatusCounts)
        .filter(([status]) => !TRANSFER_STATUS_LABELS.has(status))
        .sort(([firstStatus], [secondStatus]) =>
          firstStatus.localeCompare(secondStatus),
        )
        .map(([status, value]) => ({
          label: getTransferStatusLabel(status),
          value,
        })),
    ],
  [metrics.transferStatusCounts]);

  const recentRecords = useMemo(() => [
    ...certificates.map(createCertificateRecord),
    ...warehouseItems.map(createWarehouseRecord),
    ...transfers.map(createTransferRecord),
  ]
    .sort((first, second) => toSortTime(second.sortDate) - toSortTime(first.sortDate))
    .slice(0, 12),
  [certificates, transfers, warehouseItems]);

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
  }, [recentRecords, search]);

  const exportRecords = useMemo(
    () => toExportRecords(filteredRecords),
    [filteredRecords],
  );

  const hasAnyData =
    certificates.length > 0 ||
    warehouseItems.length > 0 ||
    transfers.length > 0;
  const loadError = loadErrors.join(' ');
  const stateMessage =
    loading
      ? 'Завантаження даних з API…'
      : loadError ||
        (!hasAnyData
          ? 'API повернув порожні списки. Дані зʼявляться тут після додавання записів у розділах посвідчень, складу або логістики.'
          : '');

  const exportPayload = {
    generatedAt: new Date().toISOString(),
    source: 'AVKU Admin Dashboard',
    summary: summaryCards,
    transferStatuses: transferStatusItems,
    loadErrors,
    records: exportRecords,
  };

  return (
    <main className={styles.page} aria-busy={loading}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>АВКУ / внутрішня система</p>
          <h1 className={styles.title}>Панель моніторингу операцій</h1>
          <p className={styles.description}>
            Єдиний центр для контролю посвідчень, складських залишків,
            передач допомоги, документів і відповідальних осіб.
          </p>
        </div>

        <div className={styles.heroActions}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={loadDashboardData}
            disabled={loading}
          >
            {loading ? 'Оновлення…' : 'Оновити дані'}
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => exportAsJson(exportPayload, 'avku-dashboard-export.json')}
            disabled={loading || !hasAnyData}
          >
            Експорт JSON
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => exportAsCsv(exportRecords, 'avku-records.csv')}
            disabled={loading || filteredRecords.length === 0}
          >
            Експорт CSV
          </button>
        </div>
      </section>

      <section className={styles.summaryGrid} aria-label="Оперативна статистика">
        {summaryCards.map((card) => (
          <article className={styles.summaryCard} key={card.label}>
            <p className={styles.cardLabel}>{card.label}</p>
            <strong className={styles.cardValue}>
              {loading ? '…' : card.value}
            </strong>
            <span className={styles.cardHint}>{card.hint}</span>
          </article>
        ))}
      </section>

      {stateMessage ? (
        <div
          className={`${styles.stateBanner} ${
            loadError ? styles.stateBannerError : styles.stateBannerInfo
          }`}
          role={loadError ? 'alert' : 'status'}
        >
          <span>{stateMessage}</span>
          {loadError ? (
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={loadDashboardData}
              disabled={loading}
            >
              Повторити
            </button>
          ) : null}
        </div>
      ) : null}

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>Останні операційні записи</h2>
              <p className={styles.panelText}>
                Знайдено: {filteredRecords.length} з {recentRecords.length}
              </p>
            </div>

            <input
              className={styles.searchInput}
              type="search"
              aria-label="Пошук записів"
              placeholder="Пошук за назвою, статусом, типом або ID"
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
                  <th>Контекст</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((record) => (
                  <tr key={record.key}>
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
                      {loading
                        ? 'Завантаження записів…'
                        : loadError
                          ? loadError
                          : hasAnyData
                            ? 'За вашим запитом записів не знайдено.'
                            : 'У підключених API поки немає записів для відображення.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <aside className={styles.sideColumn}>
          <article className={styles.panel}>
            <h2 className={styles.panelTitle}>Передачі за статусами</h2>

            <div className={styles.statusList}>
              {transferStatusItems.map((item) => (
                <div className={styles.statusItem} key={item.label}>
                  <span>{item.label}</span>
                  <strong>{loading ? '…' : item.value}</strong>
                </div>
              ))}
            </div>

            {!loading && transfers.length === 0 ? (
              <p className={styles.emptyListMessage}>
                Передачі ще не створені.
              </p>
            ) : null}
          </article>

          <article className={styles.panel}>
            <h2 className={styles.panelTitle}>Швидкі дії</h2>

            <div className={styles.actionList}>
              {quickActions.map((action) => (
                <Link
                  className={styles.actionButton}
                  key={action.path}
                  to={action.path}
                >
                  {action.label}
                </Link>
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
