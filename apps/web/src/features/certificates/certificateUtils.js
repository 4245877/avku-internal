import {
  DEFAULT_CERTIFICATE_TEMPLATE_ID,
  EMPTY_CROP,
  LEGACY_CERTIFICATE_TEMPLATE_ID,
  MAX_ZOOM,
  MIN_ZOOM,
  PHOTO_PREVIEW_WIDTH,
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

const TEMPLATE_LOCALE_LABELS = {
  uk: 'Українська',
  en: 'English',
};

/**
 * Human-friendly label for the localisation <select>: prefer a known
 * language name, then the template's own name/locale, never the raw id.
 */
export function getTemplateLabel(template) {
  if (!template) {
    return '';
  }

  const locale = normalizeWhitespace(template.locale).toLowerCase();

  return (
    TEMPLATE_LOCALE_LABELS[locale] ||
    normalizeWhitespace(template.name) ||
    template.locale ||
    template.id
  );
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
    firstNameEn: '',
    lastNameEn: '',
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
    firstNameEn: record.firstNameEn || '',
    lastNameEn: record.lastNameEn || '',
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

/**
 * Parses a hand-typed or pasted date into the `yyyy-mm-dd` value the form
 * stores. Accepts the separators people actually use (`.`, `,`, `/`, `-`,
 * spaces), a bare digit run (`31122027`) and the ISO form itself.
 * Returns an empty string when the text is not a complete, valid date.
 */
export function parseFlexibleDate(value) {
  const text = normalizeWhitespace(value);

  if (!text) {
    return '';
  }

  const isoMatch = /^(\d{4})[.,/\s-](\d{1,2})[.,/\s-](\d{1,2})$/.exec(text);
  const separatedMatch = /^(\d{1,2})[.,/\s-](\d{1,2})[.,/\s-](\d{4})$/.exec(text);
  const digitsMatch = /^(\d{2})(\d{2})(\d{4})$/.exec(text);

  let day = '';
  let month = '';
  let year = '';

  if (isoMatch) {
    [, year, month, day] = isoMatch;
  } else if (separatedMatch) {
    [, day, month, year] = separatedMatch;
  } else if (digitsMatch) {
    [, day, month, year] = digitsMatch;
  } else {
    return '';
  }

  const candidate = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');

  return parseInputDate(candidate) ? candidate : '';
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

  if (normalizeTemplateId(form.templateId).endsWith('-en')) {
    if (!normalizeWhitespace(form.firstNameEn)) {
      errors.firstNameEn = "Вкажіть ім'я англійською.";
    }

    if (!normalizeWhitespace(form.lastNameEn)) {
      errors.lastNameEn = 'Вкажіть прізвище англійською.';
    }
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
    firstNameEn: normalizeWhitespace(form.firstNameEn),
    lastNameEn: normalizeWhitespace(form.lastNameEn),
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

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Wraps any angle into (-180, 180] and keeps a tenth-of-a-degree precision. */
export function normalizeRotation(value) {
  const rotation = Number(value);

  if (!Number.isFinite(rotation)) {
    return 0;
  }

  const wrapped = ((((rotation + 180) % 360) + 360) % 360) - 180;

  return Math.round(wrapped * 10) / 10;
}

export function normalizeCrop(crop) {
  return {
    zoom: clamp(Number(crop?.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
    offsetX: Number(crop?.offsetX) || 0,
    offsetY: Number(crop?.offsetY) || 0,
    rotation: normalizeRotation(crop?.rotation),
  };
}

/**
 * Smallest scale at which the rotated image still covers every corner of the
 * frame. A rotated rect (half-extents a, b) contains the frame (half-extents
 * p, q) exactly when a ≥ p·|cos| + q·|sin| and b ≥ p·|sin| + q·|cos| — solving
 * both for the scale gives the two terms below. Reduces to the plain
 * `max(frame/image)` cover scale at rotation 0.
 */
export function getCoverScale(imageSize, frame, rotation) {
  const radians = toRadians(normalizeRotation(rotation));
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));

  return Math.max(
    (frame.width * cos + frame.height * sin) / imageSize.width,
    (frame.width * sin + frame.height * cos) / imageSize.height,
  );
}

/**
 * How far the image may travel along its **own** axes before a frame corner
 * slides off it. With rotation the valid offsets form a rotated box, so the
 * limits live in image space; `clampCrop` projects into and out of it.
 */
export function getCropLimits(imageSize, frame, zoom, rotation) {
  if (!imageSize?.width || !imageSize?.height || !frame) {
    return {
      u: 0,
      v: 0,
    };
  }

  const safeZoom = clamp(Number(zoom) || 1, MIN_ZOOM, MAX_ZOOM);
  const radians = toRadians(normalizeRotation(rotation));
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const scale = getCoverScale(imageSize, frame, rotation) * safeZoom;

  return {
    u: Math.max(0, (imageSize.width * scale - (frame.width * cos + frame.height * sin)) / 2),
    v: Math.max(0, (imageSize.height * scale - (frame.width * sin + frame.height * cos)) / 2),
  };
}

/**
 * Axis-aligned bounds of the valid offset region, in frame coordinates. Only
 * a display hint for the numeric inputs — the region itself is the rotated box
 * from `getCropLimits`, so `clampCrop` stays the source of truth.
 */
export function getCropBounds(imageSize, frame, zoom, rotation) {
  const limits = getCropLimits(imageSize, frame, zoom, rotation);
  const radians = toRadians(normalizeRotation(rotation));
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));

  return {
    x: Math.round(limits.u * cos + limits.v * sin),
    y: Math.round(limits.u * sin + limits.v * cos),
  };
}

export function clampCrop(crop, imageSize, frame) {
  const safeCrop = normalizeCrop(crop);

  if (!imageSize?.width || !imageSize?.height || !frame) {
    return safeCrop;
  }

  const limits = getCropLimits(imageSize, frame, safeCrop.zoom, safeCrop.rotation);
  const radians = toRadians(safeCrop.rotation);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Project the frame-space offset onto the image axes, clamp there, rotate back.
  const u = clamp(safeCrop.offsetX * cos + safeCrop.offsetY * sin, -limits.u, limits.u);
  const v = clamp(-safeCrop.offsetX * sin + safeCrop.offsetY * cos, -limits.v, limits.v);

  return {
    zoom: safeCrop.zoom,
    offsetX: u * cos - v * sin,
    offsetY: u * sin + v * cos,
    rotation: safeCrop.rotation,
  };
}

export function getPhotoPlacement(imageSize, frame, crop) {
  if (!imageSize?.width || !imageSize?.height || !frame) {
    return null;
  }

  const safeCrop = clampCrop(crop, imageSize, frame);
  const scale = getCoverScale(imageSize, frame, safeCrop.rotation) * safeCrop.zoom;
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;
  const left = (frame.width - width) / 2 + safeCrop.offsetX;
  const top = (frame.height - height) / 2 + safeCrop.offsetY;

  return {
    left: `${(left / frame.width) * 100}%`,
    top: `${(top / frame.height) * 100}%`,
    width: `${(width / frame.width) * 100}%`,
    height: `${(height / frame.height) * 100}%`,
    // Default transform-origin is the element centre — the same pivot the
    // renderer rotates around, so preview and PDF agree.
    transform: safeCrop.rotation ? `rotate(${safeCrop.rotation}deg)` : undefined,
  };
}

/**
 * Effective source pixels per frame pixel. Below 1 the operator is enlarging
 * past the photo's own resolution and the result will look soft.
 */
export function getEffectiveResolution(imageSize, frame, crop) {
  if (!imageSize?.width || !imageSize?.height || !frame) {
    return null;
  }

  const safeCrop = normalizeCrop(crop);

  return 1 / (getCoverScale(imageSize, frame, safeCrop.rotation) * safeCrop.zoom);
}

/**
 * Editor-sized variant of a stored photo. The cropper and preview paint into a
 * ~377px frame, so the stored original (often 3000px / several megabytes) only
 * costs bandwidth; `?w=` asks the API for a downscaled copy instead. Data URLs
 * (a photo just picked from disk) and absolute third-party URLs are returned
 * untouched — there is no API to resize them.
 */
export function getPhotoPreviewUrl(source, width = PHOTO_PREVIEW_WIDTH) {
  const url = String(source ?? '');

  if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }

  if (!/\/api\/certificates\/photos\//.test(url)) {
    return url;
  }

  return `${url}${url.includes('?') ? '&' : '?'}w=${Math.round(width)}`;
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
