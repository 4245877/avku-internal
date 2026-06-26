const API_BASE_URL = (
  import.meta.env.VITE_WAREHOUSE_API_URL ||
  import.meta.env.VITE_API_URL ||
  '/api'
).replace(/\/$/, '');

function resolveApiUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
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

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(resolveApiUrl(path), {
    ...options,
    headers,
  });

  return parseResponse(response);
}

export async function fetchWarehouseItems() {
  return requestJson('/warehouse');
}

export async function createWarehouseItem(payload) {
  return requestJson('/warehouse', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateWarehouseItem(id, payload) {
  return requestJson(`/warehouse/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteWarehouseItem(id) {
  return requestJson(`/warehouse/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function addWarehouseMovement(id, payload) {
  return requestJson(`/warehouse/${encodeURIComponent(id)}/movements`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function downloadWarehouseStock() {
  const response = await fetch(resolveApiUrl('/warehouse/export.csv'));

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const payload = await response.json();
      throw new Error(payload.error || 'Не вдалося сформувати експорт.');
    }

    throw new Error('Не вдалося сформувати експорт.');
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
