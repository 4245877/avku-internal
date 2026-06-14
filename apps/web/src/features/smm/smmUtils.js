export const publicationStatuses = [
  'Ідея',
  'В роботі',
  'Готово',
  'Опубліковано',
];

export const publicationFormats = {
  Instagram: ['Пост', 'Stories', 'Reels'],
  YouTube: ['Shorts', 'Відео'],
};

export const permissionLabels = {
  yes: 'Публікацію дозволено',
  no: 'Публікацію заборонено',
  unknown: 'Дозвіл невідомий',
};

export function formatDate(dateValue, options = {}) {
  if (!dateValue) {
    return 'Без дати';
  }

  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    ...options,
  }).format(new Date(`${dateValue}T12:00:00`));
}

export function formatShortDate(dateValue) {
  return formatDate(dateValue, { month: 'short' });
}

export function getMaterialTitle(material) {
  return material.event || material.description || 'Матеріал без назви';
}

export function getMaterialIssues(material) {
  const issues = [];

  if (!material.description.trim()) {
    issues.push('немає опису');
  }

  if (material.permission === 'unknown') {
    issues.push('дозвіл не визначено');
  }

  if (!material.driveUrl && material.fileNames.length === 0) {
    issues.push('немає файлу або посилання');
  }

  return issues;
}

export function getPlatformClassName(platform) {
  return platform === 'Instagram' ? 'instagram' : 'youtube';
}

export function getStatusClassName(status) {
  const classNames = {
    Ідея: 'idea',
    'В роботі': 'progress',
    Готово: 'ready',
    Опубліковано: 'published',
  };

  return classNames[status] ?? 'idea';
}

