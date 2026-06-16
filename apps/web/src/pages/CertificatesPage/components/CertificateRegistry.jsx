import { useMemo, useState } from 'react';

import {
  formatDate,
  getCertificateStatus,
  normalizeWhitespace,
} from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

function CertificateRegistry({
  records,
  selectedId,
  loading,
  actionState,
  onOpen,
  onRenew,
  onReplacePhoto,
  onExport,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const filteredRecords = useMemo(() => {
    const query = normalizeWhitespace(searchQuery).toLowerCase();

    if (!query) {
      return records;
    }

    return records.filter((record) =>
      [
        record.fullName,
        record.certificateNumber,
        formatDate(record.issuedAt),
        formatDate(record.validUntil),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [records, searchQuery]);

  return (
    <aside className={styles.registryPane} aria-label="Реестр удостоверений">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Реестр</p>
          <h2 className={styles.paneTitle}>Сохранённые записи</h2>
        </div>
      </div>

      <label className={styles.searchLabel}>
        <span>Поиск</span>
        <input
          className={styles.input}
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="ФИО, номер или дата"
        />
      </label>

      <div className={styles.recordList}>
        {loading ? <div className={styles.emptyRegistry}>Загрузка реестра...</div> : null}

        {!loading && filteredRecords.length === 0 ? (
          <div className={styles.emptyRegistry}>
            <strong>Нет записей</strong>
            <span>Сохранённые удостоверения появятся здесь.</span>
          </div>
        ) : null}

        {!loading
          ? filteredRecords.map((record) => {
            const status = getCertificateStatus(record.validUntil);
            const isBusy = actionState?.id === record.id;

            return (
              <article
                className={[
                  styles.recordItem,
                  selectedId === record.id ? styles.recordItemActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={record.id}
              >
                <button className={styles.recordOpenButton} type="button" onClick={() => onOpen(record)}>
                  <span className={styles.recordName}>{record.fullName}</span>
                  <span className={styles.recordMeta}>
                    № {record.certificateNumber} · выдано {formatDate(record.issuedAt)} · до {formatDate(record.validUntil)}
                  </span>
                </button>

                <div className={styles.recordControls}>
                  <span className={`${styles.statusBadge} ${styles[`status-${status.tone}`]}`}>
                    {status.label}
                  </span>

                  <div className={styles.recordActions}>
                    <button className={styles.linkButton} type="button" onClick={() => onOpen(record)}>
                      Открыть
                    </button>
                    <button className={styles.linkButton} type="button" onClick={() => onRenew(record)} disabled={isBusy}>
                      {isBusy && actionState.type === 'renew' ? '...' : 'Продлить'}
                    </button>
                    <button className={styles.linkButton} type="button" onClick={() => onReplacePhoto(record)}>
                      Фото
                    </button>
                    <button className={styles.linkButton} type="button" onClick={() => onExport(record, 'png')} disabled={isBusy}>
                      {isBusy && actionState.type === 'png' ? '...' : 'PNG'}
                    </button>
                    <button className={styles.linkButton} type="button" onClick={() => onExport(record, 'pdf')} disabled={isBusy}>
                      {isBusy && actionState.type === 'pdf' ? '...' : 'PDF'}
                    </button>
                  </div>
                </div>
              </article>
            );
          })
          : null}
      </div>
    </aside>
  );
}

export default CertificateRegistry;
