import {
  DEFAULT_CERTIFICATE_TEMPLATE_ID,
  EMPTY_CROP,
  LEGACY_CERTIFICATE_TEMPLATE_ID,
} from './certificateTypes.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeWhitespace(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeTemplateId(value) {
  const templateId = normalizeWhitespace(value).toLowerCase();

  if (!templateId || templateId === LEGACY_CERTIFICATE_TEMPLATE_ID) {
    return DEFAULT_CERTIFICATE_TEMPLATE_ID;
  }

  return templateId;
}

export function toInputDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getTodayInputDate() {
  return toInputDate(new Date());
}

export function getDefaultValidUntil() {
  const date = new Date();

  date.setFullYear(date.getFullYear() + 1);

  return toInputDate(date);
}

export function getEmptyCertificateForm(templateId = DEFAULT_CERTIFICATE_TEMPLATE_ID) {
  return {
    id: '',
    fullName: '',
    certificateNumber: '',
    issuedAt: getTodayInputDate(),
    validUntil: getDefaultValidUntil(),
    templateId: normalizeTemplateId(templateId),
    photoUrl: '',
    photoDataUrl: '',
    photoFile: null,
    photoCrop: {
      ...EMPTY_CROP,
    },
    createdAt: '',
    updatedAt: '',
  };
}

export function createFormFromRecord(record) {
  return {
    id: record.id,
    fullName: record.fullName,
    certificateNumber: record.certificateNumber,
    issuedAt: record.issuedAt,
    validUntil: record.validUntil,
    templateId: normalizeTemplateId(record.templateId),
    photoUrl: record.photoUrl,
    photoDataUrl: '',
    photoFile: null,
    photoCrop: {
      ...EMPTY_CROP,
      ...record.photoCrop,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function parseInputDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function formatDate(value) {
  const date = parseInputDate(value);

  if (!date) {
    return value || '—';
  }

  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('.');
}

function startOfToday() {
  const today = new Date();

  return new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

export function addOneYear(value) {
  const today = startOfToday();
  const parsedDate = parseInputDate(value);
  const baseDate = parsedDate && parsedDate > today ? parsedDate : today;
  const nextDate = new Date(baseDate);

  nextDate.setFullYear(nextDate.getFullYear() + 1);

  return toInputDate(nextDate);
}

export function getCertificateStatus(value) {
  const date = parseInputDate(value);

  if (!date) {
    return {
      label: 'Без дати',
      tone: 'muted',
    };
  }

  const daysLeft = Math.ceil((date.getTime() - startOfToday().getTime()) / DAY_MS);

  if (daysLeft < 0) {
    return {
      label: 'Прострочено',
      tone: 'expired',
    };
  }

  if (daysLeft <= 30) {
    return {
      label: `${daysLeft} дн.`,
      tone: 'soon',
    };
  }

  return {
    label: 'Дійсне',
    tone: 'active',
  };
}

export function validateCertificateForm(form) {
  const errors = {};
  const issuedAtDate = parseInputDate(form.issuedAt);
  const validUntilDate = parseInputDate(form.validUntil);

  if (!normalizeWhitespace(form.fullName)) {
    errors.fullName = 'Вкажіть ПІБ.';
  }

  if (!normalizeWhitespace(form.certificateNumber)) {
    errors.certificateNumber = 'Вкажіть номер посвідчення.';
  }

  if (!issuedAtDate) {
    errors.issuedAt = 'Вкажіть дату видачі.';
  }

  if (!validUntilDate) {
    errors.validUntil = 'Вкажіть дату завершення дії.';
  } else if (issuedAtDate && validUntilDate < issuedAtDate) {
    errors.validUntil = 'Дата завершення дії має бути не раніше дати видачі.';
  }

  if (!normalizeWhitespace(form.templateId)) {
    errors.templateId = 'Вкажіть шаблон посвідчення.';
  }

  if (!form.photoUrl && !form.photoDataUrl && !form.photoFile) {
    errors.photo = 'Завантажте фотографію.';
  }

  return errors;
}

export function hasValidationErrors(errors) {
  return Object.keys(errors).length > 0;
}

export function buildCertificatePayload(form) {
  return {
    fullName: normalizeWhitespace(form.fullName),
    certificateNumber: normalizeWhitespace(form.certificateNumber),
    issuedAt: form.issuedAt,
    validUntil: form.validUntil,
    templateId: normalizeTemplateId(form.templateId),
    photoDataUrl: form.photoFile ? undefined : form.photoDataUrl || undefined,
    photoFile: form.photoFile || undefined,
    photoCrop: form.photoCrop,
  };
}

export function buildCertificateSnapshot(form) {
  const payload = buildCertificatePayload(form);

  return JSON.stringify({
    ...payload,
    photoFile: payload.photoFile
      ? [
        payload.photoFile.name,
        payload.photoFile.size,
        payload.photoFile.lastModified,
      ].join(':')
      : undefined,
  });
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function normalizeCrop(crop) {
  return {
    zoom: clamp(Number(crop?.zoom) || 1, 1, 3),
    offsetX: Number(crop?.offsetX) || 0,
    offsetY: Number(crop?.offsetY) || 0,
  };
}

export function getCropLimits(imageSize, frame, zoom) {
  if (!imageSize?.width || !imageSize?.height || !frame) {
    return {
      x: 0,
      y: 0,
    };
  }

  const safeZoom = clamp(Number(zoom) || 1, 1, 3);
  const scale = Math.max(frame.width / imageSize.width, frame.height / imageSize.height) * safeZoom;

  return {
    x: Math.max(0, Math.round((imageSize.width * scale - frame.width) / 2)),
    y: Math.max(0, Math.round((imageSize.height * scale - frame.height) / 2)),
  };
}

export function clampCrop(crop, imageSize, frame) {
  const safeCrop = normalizeCrop(crop);
  const limits = getCropLimits(imageSize, frame, safeCrop.zoom);

  return {
    zoom: safeCrop.zoom,
    offsetX: clamp(safeCrop.offsetX, -limits.x, limits.x),
    offsetY: clamp(safeCrop.offsetY, -limits.y, limits.y),
  };
}

export function getPhotoPlacement(imageSize, frame, crop) {
  if (!imageSize?.width || !imageSize?.height || !frame) {
    return null;
  }

  const safeCrop = clampCrop(crop, imageSize, frame);
  const scale = Math.max(frame.width / imageSize.width, frame.height / imageSize.height) * safeCrop.zoom;
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;
  const left = (frame.width - width) / 2 + safeCrop.offsetX;
  const top = (frame.height - height) / 2 + safeCrop.offsetY;

  return {
    left: `${(left / frame.width) * 100}%`,
    top: `${(top / frame.height) * 100}%`,
    width: `${(width / frame.width) * 100}%`,
    height: `${(height / frame.height) * 100}%`,
  };
}

export function getImageSize(source) {
  return new Promise((resolve, reject) => {
    if (!source) {
      resolve(null);
      return;
    }

    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = reject;
    image.src = source;
  });
}

export function splitFullName(value) {
  const [lastName = '', ...rest] = normalizeWhitespace(value).split(' ');

  return {
    lastName,
    firstAndMiddleName: rest.join(' '),
  };
}

export function buildDownloadFileName(record, extension) {
  const safeNumber = normalizeWhitespace(record.certificateNumber).replace(/[^\p{L}\p{N}-]+/gu, '-');
  const safeName = normalizeWhitespace(record.fullName).replace(/[^\p{L}\p{N}-]+/gu, '-');
  const baseName = [safeNumber || 'certificate', safeName].filter(Boolean).join('-');

  return `${baseName}.${extension}`;
}
