function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();

  URL.revokeObjectURL(url);
}

export function exportAsJson(data, fileName = 'export.json') {
  const json = JSON.stringify(data, null, 2);

  downloadFile(json, fileName, 'application/json;charset=utf-8');
}

export function exportAsCsv(records, fileName = 'export.csv') {
  if (!Array.isArray(records) || records.length === 0) {
    downloadFile('', fileName, 'text/csv;charset=utf-8');
    return;
  }

  const headers = Object.keys(records[0]);

  const escapeCsvValue = (value) => {
    const stringValue = String(value ?? '');
    const escapedValue = stringValue.replaceAll('"', '""');

    return `"${escapedValue}"`;
  };

  const rows = records.map((record) => {
    return headers.map((header) => escapeCsvValue(record[header])).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');

  downloadFile(csv, fileName, 'text/csv;charset=utf-8');
}