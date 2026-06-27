export const TRANSFER_STATUS_OPTIONS = [
  { value: 'planned', label: 'Заплановано' },
  { value: 'transferred', label: 'Передано' },
  { value: 'report', label: 'Потрібно дозавантажити звіт' },
];

export const ACT_STATE_OPTIONS = [
  { value: 'missing', label: 'Не створено' },
  { value: 'pending', label: 'Підготовлено' },
  { value: 'ready', label: 'Підписано' },
];

export const PHOTO_STATE_OPTIONS = [
  { value: 'missing', label: 'Немає' },
  { value: 'pending', label: 'Очікується' },
  { value: 'ready', label: 'Завантажено' },
];

const STATUS_LABELS = {
  planned: 'Заплановано',
  transferred: 'Передано',
  report: 'Потрібно дозавантажити звіт',
};

const STATUS_TONES = {
  planned: 'planned',
  transferred: 'transferred',
  report: 'report',
};

const DOCUMENT_TONES = {
  ready: 'complete',
  pending: 'partial',
  missing: 'missing',
};

const EVENT_TYPE_LABELS = {
  created: 'Створення',
  status: 'Статус',
  act: 'Акт',
  photo: 'Фото',
  note: 'Нотатка',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getToday() {
  return new Date().toISOString().slice(0, 10);
}

export function getEmptyTransferForm() {
  return {
    id: '',
    route: '',
    recipient: '',
    driver: '',
    transferDate: getToday(),
    status: 'planned',
    routeConfirmed: false,
    actState: 'missing',
    actReference: '',
    photoState: 'missing',
    photoCount: '',
    requestId: '',
    warehouseId: '',
    reportId: '',
    notes: '',
    manifest: [{ name: '', quantity: '' }],
  };
}

export function createFormFromTransfer(transfer) {
  return {
    id: transfer.id,
    route: transfer.route ?? '',
    recipient: transfer.recipient ?? '',
    driver: transfer.driver ?? '',
    transferDate: transfer.transferDate ?? getToday(),
    status: transfer.status ?? 'planned',
    routeConfirmed: Boolean(transfer.routeConfirmed),
    actState: transfer.actState ?? 'missing',
    actReference: transfer.actReference ?? '',
    photoState: transfer.photoState ?? 'missing',
    photoCount:
      transfer.photoCount === undefined || transfer.photoCount === null
        ? ''
        : String(transfer.photoCount),
    requestId: transfer.requestId ?? '',
    warehouseId: transfer.warehouseId ?? '',
    reportId: transfer.reportId ?? '',
    notes: transfer.notes ?? '',
    manifest:
      Array.isArray(transfer.manifest) && transfer.manifest.length > 0
        ? transfer.manifest.map((line) => ({
            name: line.name ?? '',
            quantity: line.quantity ?? '',
          }))
        : [{ name: '', quantity: '' }],
  };
}

export function validateTransferForm(form) {
  const errors = {};

  if (!form.route.trim()) {
    errors.route = 'Вкажіть маршрут передачі.';
  }

  if (!form.recipient.trim()) {
    errors.recipient = 'Вкажіть отримувача.';
  }

  if (!form.driver.trim()) {
    errors.driver = 'Вкажіть водія або волонтера.';
  }

  if (!form.transferDate.trim()) {
    errors.transferDate = 'Вкажіть дату передачі.';
  } else if (!DATE_PATTERN.test(form.transferDate)) {
    errors.transferDate = 'Дата має бути у форматі РРРР-ММ-ДД.';
  }

  if (form.photoState === 'ready' && form.photoCount !== '') {
    const count = Number(form.photoCount);

    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
      errors.photoCount = 'Кількість фото має бути цілим числом від 0.';
    }
  }

  const hasBrokenManifestLine = form.manifest.some(
    (line) => !line.name.trim() && line.quantity.trim(),
  );

  if (hasBrokenManifestLine) {
    errors.manifest = 'Вкажіть назву для кожної позиції передачі.';
  }

  return errors;
}

export function hasValidationErrors(errors) {
  return Object.values(errors).some(Boolean);
}

export function buildTransferPayload(form) {
  return {
    route: form.route.trim(),
    recipient: form.recipient.trim(),
    driver: form.driver.trim(),
    transferDate: form.transferDate.trim(),
    status: form.status,
    routeConfirmed: Boolean(form.routeConfirmed),
    actState: form.actState,
    actReference: form.actState === 'missing' ? '' : form.actReference.trim(),
    photoState: form.photoState,
    photoCount:
      form.photoState === 'missing' || form.photoCount === ''
        ? 0
        : Number(form.photoCount),
    requestId: form.requestId.trim(),
    warehouseId: form.warehouseId.trim(),
    reportId: form.reportId.trim(),
    notes: form.notes.trim(),
    manifest: form.manifest
      .map((line) => ({
        name: line.name.trim(),
        quantity: line.quantity.trim(),
      }))
      .filter((line) => line.name || line.quantity),
  };
}

export function getStatusBadge(transfer) {
  const status = transfer.status ?? 'planned';

  return {
    label: STATUS_LABELS[status] ?? STATUS_LABELS.planned,
    tone: STATUS_TONES[status] ?? 'planned',
  };
}

export function getActLabel(transfer) {
  if (transfer.actState === 'ready') {
    return transfer.actReference || 'Акт підписано';
  }

  if (transfer.actState === 'pending') {
    return 'Акт підготовлено';
  }

  return 'Акт не створено';
}

export function getPhotoLabel(transfer) {
  if (transfer.photoState === 'ready') {
    return transfer.photoCount > 0
      ? `${transfer.photoCount} фото завантажено`
      : 'Фото завантажено';
  }

  if (transfer.photoState === 'pending') {
    return 'Очікується після передачі';
  }

  return 'Фото немає';
}

export function getActBadge(transfer) {
  return {
    label: getActLabel(transfer),
    tone: DOCUMENT_TONES[transfer.actState] ?? 'partial',
  };
}

export function getPhotoBadge(transfer) {
  return {
    label: getPhotoLabel(transfer),
    tone: DOCUMENT_TONES[transfer.photoState] ?? 'partial',
  };
}

export function isReportReady(transfer) {
  return (
    transfer.status === 'transferred' &&
    transfer.actState === 'ready' &&
    transfer.photoState === 'ready' &&
    Boolean(transfer.reportId)
  );
}

export function buildChecklist(transfer) {
  const actState =
    transfer.actState === 'ready'
      ? 'Підписано'
      : transfer.actState === 'pending'
        ? 'Чернетка'
        : 'Потрібно створити';
  const photoState =
    transfer.photoState === 'ready'
      ? 'Завантажено'
      : transfer.photoState === 'pending'
        ? 'Після вручення'
        : 'Потрібно додати';
  const reportReady = isReportReady(transfer);
  const reportState = reportReady
    ? 'Готовий'
    : transfer.reportId
      ? 'Очікує матеріали'
      : 'Створити картку';

  return [
    {
      label: 'Маршрут погоджено',
      done: Boolean(transfer.routeConfirmed),
      state: transfer.routeConfirmed ? 'Готово' : 'Уточнюється',
    },
    {
      label: 'Акт передачі',
      done: transfer.actState === 'ready',
      state: actState,
    },
    {
      label: 'Фото передачі',
      done: transfer.photoState === 'ready',
      state: photoState,
    },
    {
      label: 'Звіт',
      done: reportReady,
      state: reportState,
    },
  ];
}

export function getEventTypeLabel(type) {
  return EVENT_TYPE_LABELS[type] ?? EVENT_TYPE_LABELS.note;
}

export function summarizeTransfers(transfers) {
  return transfers.reduce(
    (summary, transfer) => {
      if (transfer.status === 'planned') {
        summary.planned += 1;
      } else if (transfer.status === 'transferred') {
        summary.transferred += 1;
      } else if (transfer.status === 'report') {
        summary.needsReport += 1;
      }

      if (
        transfer.actState === 'missing' ||
        transfer.photoState === 'missing'
      ) {
        summary.missingFiles += 1;
      }

      return summary;
    },
    {
      planned: 0,
      transferred: 0,
      needsReport: 0,
      missingFiles: 0,
    },
  );
}

export function filterTransfers(transfers, { search, status, documents }) {
  const normalizedSearch = search.trim().toLowerCase();

  return transfers.filter((transfer) => {
    const matchesStatus = status === 'all' || transfer.status === status;
    const matchesDocuments =
      documents === 'all' ||
      (documents === 'missingAct' && transfer.actState === 'missing') ||
      (documents === 'missingPhoto' && transfer.photoState === 'missing') ||
      (documents === 'reportReady' &&
        transfer.actState === 'ready' &&
        transfer.photoState === 'ready');
    const matchesSearch =
      !normalizedSearch ||
      [
        transfer.code,
        transfer.route,
        transfer.recipient,
        transfer.driver,
        getStatusBadge(transfer).label,
        transfer.requestId,
        transfer.warehouseId,
        transfer.reportId,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);

    return matchesStatus && matchesDocuments && matchesSearch;
  });
}

export function sortTransfers(transfers) {
  return [...transfers].sort((first, second) => {
    const firstDate = Date.parse(first?.transferDate ?? '') || 0;
    const secondDate = Date.parse(second?.transferDate ?? '') || 0;

    if (secondDate !== firstDate) {
      return secondDate - firstDate;
    }

    const firstUpdated = Date.parse(first?.updatedAt ?? '') || 0;
    const secondUpdated = Date.parse(second?.updatedAt ?? '') || 0;

    return secondUpdated - firstUpdated;
  });
}

export function upsertTransfer(transfers, nextTransfer) {
  const others = transfers.filter(
    (transfer) => transfer.id !== nextTransfer.id,
  );

  return sortTransfers([nextTransfer, ...others]);
}
