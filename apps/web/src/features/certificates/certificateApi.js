const API_BASE_URL = (
  import.meta.env.VITE_CERTIFICATES_API_URL ||
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001/api'
    : '/api')
).replace(/\/$/, '');

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
  const response = await fetch(resolveApiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  return parseResponse(response);
}

function normalizeRecord(record) {
  return {
    ...record,
    photoUrl: resolveStorageUrl(record.photoUrl),
    exportUrls: {
      png: resolveStorageUrl(record.exportUrls?.png),
      pdf: resolveStorageUrl(record.exportUrls?.pdf),
    },
  };
}

export async function fetchCertificateTemplate() {
  const template = await requestJson('/certificates/template');

  return {
    ...template,
    assets: {
      backgroundUrl: resolveStorageUrl(template.assets.backgroundUrl),
      stampOverlayUrl: resolveStorageUrl(template.assets.stampOverlayUrl),
    },
  };
}

export async function fetchCertificates() {
  const records = await requestJson('/certificates');

  return records.map(normalizeRecord);
}

export async function createCertificate(payload) {
  return normalizeRecord(
    await requestJson('/certificates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );
}

export async function updateCertificate(id, payload) {
  return normalizeRecord(
    await requestJson(`/certificates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  );
}

export async function renewCertificate(id) {
  return normalizeRecord(
    await requestJson(`/certificates/${encodeURIComponent(id)}/renew`, {
      method: 'PATCH',
    }),
  );
}

export async function downloadCertificate(record, format) {
  const url = resolveStorageUrl(record.exportUrls?.[format]);
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
