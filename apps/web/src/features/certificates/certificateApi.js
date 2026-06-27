import fallbackEnBackgroundUrl from '../../assets/certificates/volunteer-card-v1-en/background.png';
import fallbackEnLayout from '../../assets/certificates/volunteer-card-v1-en/layout.json';
import fallbackEnStampOverlayUrl from '../../assets/certificates/volunteer-card-v1-en/stamp-overlay.png';
import fallbackUkBackgroundUrl from '../../assets/certificates/volunteer-card-v1-uk/background.png';
import fallbackUkLayout from '../../assets/certificates/volunteer-card-v1-uk/layout.json';
import fallbackUkStampOverlayUrl from '../../assets/certificates/volunteer-card-v1-uk/stamp-overlay.png';

import {
  DEFAULT_CERTIFICATE_TEMPLATE_ID,
  LEGACY_CERTIFICATE_TEMPLATE_ID,
} from './certificateTypes.js';
import { normalizeTemplateId } from './certificateUtils.js';

const API_BASE_URL = (
  import.meta.env.VITE_CERTIFICATES_API_URL ||
  import.meta.env.VITE_API_URL ||
  '/api'
).replace(/\/$/, '');
const FALLBACK_TEMPLATES = {
  [DEFAULT_CERTIFICATE_TEMPLATE_ID]: {
    id: DEFAULT_CERTIFICATE_TEMPLATE_ID,
    name: 'UA',
    locale: 'uk',
    layout: fallbackUkLayout,
    assets: {
      backgroundUrl: fallbackUkBackgroundUrl,
      stampOverlayUrl: fallbackUkStampOverlayUrl,
    },
  },
  'volunteer-card-v1-en': {
    id: 'volunteer-card-v1-en',
    name: 'EN',
    locale: 'en',
    layout: fallbackEnLayout,
    assets: {
      backgroundUrl: fallbackEnBackgroundUrl,
      stampOverlayUrl: fallbackEnStampOverlayUrl,
    },
  },
};
const FALLBACK_TEMPLATE_WARNING =
  'Шаблон із API недоступний; використовується локальна копія для попереднього перегляду.';

function resolveApiUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveStorageUrl(url) {
  if (!url) {
    return '';
  }

  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) {
    return url;
  }

  if (url.startsWith('/api/')) {
    if (/^https?:\/\//i.test(API_BASE_URL)) {
      return `${new URL(API_BASE_URL).origin}${url}`;
    }

    return url;
  }

  return resolveApiUrl(url);
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Помилка API.');
    }

    return payload;
  }

  if (!response.ok) {
    throw new Error('Помилка API.');
  }

  return response.blob();
}

async function requestJson(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(resolveApiUrl(path), {
    ...options,
    headers,
  });

  return parseResponse(response);
}

function hasPhotoFile(payload) {
  return typeof File !== 'undefined' && payload.photoFile instanceof File;
}

function appendCertificateFields(formData, payload) {
  formData.append('fullName', payload.fullName ?? '');
  formData.append('certificateNumber', payload.certificateNumber ?? '');
  formData.append('issuedAt', payload.issuedAt ?? '');
  formData.append('validUntil', payload.validUntil ?? '');
  formData.append('templateId', normalizeTemplateId(payload.templateId));
  formData.append('photoCrop', JSON.stringify(payload.photoCrop ?? {}));
}

function buildCertificateRequestOptions(method, payload) {
  const { photoFile, ...jsonPayload } = payload;

  if (hasPhotoFile(payload)) {
    const formData = new FormData();

    appendCertificateFields(formData, payload);
    formData.append('photo', photoFile, photoFile.name);

    return {
      method,
      body: formData,
    };
  }

  return {
    method,
    body: JSON.stringify(jsonPayload),
  };
}

function normalizeRecord(record) {
  return {
    ...record,
    templateId: normalizeTemplateId(record.templateId),
    photoUrl: resolveStorageUrl(record.photoUrl),
    exportUrls: {
      png: resolveStorageUrl(record.exportUrls?.png),
      pdf: resolveStorageUrl(record.exportUrls?.pdf),
    },
  };
}

function getFallbackTemplate(templateId) {
  const normalizedTemplateId = templateId === LEGACY_CERTIFICATE_TEMPLATE_ID
    ? DEFAULT_CERTIFICATE_TEMPLATE_ID
    : normalizeTemplateId(templateId);

  return FALLBACK_TEMPLATES[normalizedTemplateId] ??
    FALLBACK_TEMPLATES[DEFAULT_CERTIFICATE_TEMPLATE_ID];
}

function sortTemplates(templates, defaultId) {
  return [...templates].sort((first, second) => {
    if (first.id === defaultId && second.id !== defaultId) {
      return -1;
    }

    if (second.id === defaultId && first.id !== defaultId) {
      return 1;
    }

    return first.id.localeCompare(second.id);
  });
}

function normalizeTemplate(template = {}, options = {}) {
  const templateId = normalizeTemplateId(template.id || template.layout?.id);
  const fallbackTemplate = getFallbackTemplate(templateId);
  const layout = {
    ...fallbackTemplate.layout,
    ...(template.layout || {}),
    id: templateId,
  };
  const name = template.name || layout.name || fallbackTemplate.name || templateId;
  const locale = template.locale || layout.locale || fallbackTemplate.locale || '';

  return {
    ...template,
    id: templateId,
    name,
    locale,
    layout: {
      ...layout,
      id: templateId,
      name,
      locale,
    },
    isDefault: Boolean(template.isDefault) || templateId === DEFAULT_CERTIFICATE_TEMPLATE_ID,
    isFallback: Boolean(options.isFallback),
    warning: options.warning || '',
    assets: {
      backgroundUrl: resolveStorageUrl(template.assets?.backgroundUrl) ||
        fallbackTemplate.assets.backgroundUrl,
      stampOverlayUrl: resolveStorageUrl(template.assets?.stampOverlayUrl) ||
        fallbackTemplate.assets.stampOverlayUrl,
      backgroundFallbackUrl: fallbackTemplate.assets.backgroundUrl,
      stampOverlayFallbackUrl: fallbackTemplate.assets.stampOverlayUrl,
    },
  };
}

function normalizeTemplateCatalog(response = {}, options = {}) {
  const sourceTemplates = Array.isArray(response.templates)
    ? response.templates
    : [response];
  const defaultId = normalizeTemplateId(response.defaultId);
  const templates = sortTemplates(
    sourceTemplates.length > 0
      ? sourceTemplates.map((template) => normalizeTemplate(template, options))
      : Object.values(FALLBACK_TEMPLATES).map((template) => normalizeTemplate(template, options)),
    defaultId,
  ).map((template) => ({
    ...template,
    isDefault: template.id === defaultId,
  }));

  return {
    defaultId,
    templates,
    warning: options.warning || '',
  };
}

export async function fetchCertificateTemplates() {
  try {
    return normalizeTemplateCatalog(
      await requestJson('/certificates/templates'),
    );
  } catch {
    return normalizeTemplateCatalog(
      {
        defaultId: DEFAULT_CERTIFICATE_TEMPLATE_ID,
        templates: Object.values(FALLBACK_TEMPLATES),
      },
      {
        isFallback: true,
        warning: FALLBACK_TEMPLATE_WARNING,
      },
    );
  }
}

export async function fetchCertificateTemplate(templateId = DEFAULT_CERTIFICATE_TEMPLATE_ID) {
  try {
    return normalizeTemplate(
      await requestJson(`/certificates/template?templateId=${encodeURIComponent(templateId)}`),
    );
  } catch {
    return normalizeTemplate(
      getFallbackTemplate(templateId),
      {
        isFallback: true,
        warning: FALLBACK_TEMPLATE_WARNING,
      },
    );
  }
}

export async function fetchCertificates() {
  const records = await requestJson('/certificates');

  return records.map(normalizeRecord);
}

export async function createCertificate(payload) {
  return normalizeRecord(
    await requestJson(
      '/certificates',
      buildCertificateRequestOptions('POST', payload),
    ),
  );
}

export async function updateCertificate(id, payload) {
  return normalizeRecord(
    await requestJson(
      `/certificates/${encodeURIComponent(id)}`,
      buildCertificateRequestOptions('PUT', payload),
    ),
  );
}

export async function renewCertificate(id) {
  return normalizeRecord(
    await requestJson(`/certificates/${encodeURIComponent(id)}/renew`, {
      method: 'PATCH',
    }),
  );
}

export async function deleteCertificate(id) {
  return requestJson(`/certificates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function downloadCertificate(record, format) {
  const url = resolveStorageUrl(record.exportUrls?.[format]);

  if (!url) {
    throw new Error('Немає посилання для експорту посвідчення.');
  }

  const response = await fetch(url);

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const payload = await response.json();
      throw new Error(payload.error || 'Не вдалося сформувати файл.');
    }

    throw new Error('Не вдалося сформувати файл.');
  }

  return response.blob();
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.click();

  URL.revokeObjectURL(url);
}
