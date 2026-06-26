export const WAREHOUSE_CATEGORIES = [
  'Дрони',
  'Генератори',
  'Продукти',
  'Медикаменти',
  'Сітки',
  'Свічки',
  'Одяг',
];

export const NO_RESERVE_LABEL = 'Немає резерву';

const MOVEMENT_TYPE_LABELS = {
  receipt: 'Надходження',
  issue: 'Видача',
  reserve: 'Резерв',
  note: 'Нотатка',
};

export function getEmptyItemForm() {
  return {
    id: '',
    name: '',
    category: WAREHOUSE_CATEGORIES[0],
    quantity: '',
    unit: 'шт.',
    availableNow: '',
    condition: '',
    location: '',
    reservedFor: '',
    needsCheck: false,
  };
}

export function createFormFromItem(item) {
  return {
    id: item.id,
    name: item.name ?? '',
    category: item.category ?? WAREHOUSE_CATEGORIES[0],
    quantity: String(item.quantity ?? ''),
    unit: item.unit ?? 'шт.',
    availableNow: String(item.availableNow ?? ''),
    condition: item.condition ?? '',
    location: item.location ?? '',
    reservedFor: item.reservedFor ?? '',
    needsCheck: Boolean(item.needsCheck),
  };
}

export function validateItemForm(form) {
  const errors = {};
  const quantity = Number(form.quantity);
  const availableNow = Number(form.availableNow);

  if (!form.name.trim()) {
    errors.name = 'Вкажіть назву позиції.';
  }

  if (!form.category.trim()) {
    errors.category = 'Оберіть категорію.';
  }

  if (!form.unit.trim()) {
    errors.unit = 'Вкажіть одиницю виміру.';
  }

  if (
    form.quantity === '' ||
    !Number.isFinite(quantity) ||
    !Number.isInteger(quantity) ||
    quantity < 0
  ) {
    errors.quantity = 'Кількість має бути цілим числом від 0.';
  }

  if (
    form.availableNow === '' ||
    !Number.isFinite(availableNow) ||
    !Number.isInteger(availableNow) ||
    availableNow < 0
  ) {
    errors.availableNow = 'Доступно зараз має бути цілим числом від 0.';
  } else if (
    Number.isFinite(quantity) &&
    availableNow > quantity
  ) {
    errors.availableNow = 'Доступно зараз не може перевищувати загальну кількість.';
  }

  return errors;
}

export function hasValidationErrors(errors) {
  return Object.values(errors).some(Boolean);
}

export function buildItemPayload(form) {
  return {
    name: form.name.trim(),
    category: form.category.trim(),
    quantity: Number(form.quantity),
    unit: form.unit.trim(),
    availableNow: Number(form.availableNow),
    condition: form.condition.trim(),
    location: form.location.trim(),
    reservedFor: form.reservedFor.trim(),
    needsCheck: Boolean(form.needsCheck),
  };
}

export function hasReserve(item) {
  return Boolean(item.reservedFor && item.reservedFor.trim());
}

export function getReserveLabel(item) {
  return hasReserve(item) ? item.reservedFor : NO_RESERVE_LABEL;
}

export function getItemStatus(item) {
  if (item.needsCheck) {
    return { label: 'Потрібна перевірка', tone: 'warning' };
  }

  if (item.availableNow <= 0) {
    return { label: 'Немає вільного залишку', tone: 'warning' };
  }

  if (item.availableNow >= item.quantity) {
    return { label: 'Можна видати', tone: 'ready' };
  }

  return { label: 'Частково доступно', tone: 'progress' };
}

export function getAvailabilityLabel(item) {
  if (item.availableNow <= 0) {
    return 'Немає для негайної видачі';
  }

  if (item.availableNow >= item.quantity) {
    return 'Можна видати все';
  }

  return `Можна видати ${item.availableNow} ${item.unit}`;
}

export function getMovementTypeLabel(type) {
  return MOVEMENT_TYPE_LABELS[type] ?? MOVEMENT_TYPE_LABELS.note;
}

export function summarizeItems(items) {
  return items.reduce(
    (summary, item) => {
      summary.totalQuantity += item.quantity;
      summary.availableNow += item.availableNow;

      if (hasReserve(item)) {
        summary.reservedItems += 1;
      }

      if (getItemStatus(item).tone === 'warning') {
        summary.needsCheck += 1;
      }

      return summary;
    },
    {
      totalQuantity: 0,
      availableNow: 0,
      reservedItems: 0,
      needsCheck: 0,
    },
  );
}

export function filterItems(items, { search, category, availability }) {
  const normalizedSearch = search.trim().toLowerCase();

  return items.filter((item) => {
    const status = getItemStatus(item);
    const matchesCategory = category === 'all' || item.category === category;
    const matchesAvailability =
      availability === 'all' ||
      (availability === 'now' && item.availableNow > 0) ||
      (availability === 'reserved' && hasReserve(item)) ||
      (availability === 'check' && status.tone === 'warning');
    const matchesSearch =
      !normalizedSearch ||
      [
        item.code,
        item.name,
        item.category,
        item.condition,
        item.location,
        getReserveLabel(item),
        status.label,
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);

    return matchesCategory && matchesAvailability && matchesSearch;
  });
}

export function sortItemsByUpdatedAt(items) {
  return [...items].sort((first, second) => {
    const firstTime = Date.parse(first?.updatedAt ?? '') || 0;
    const secondTime = Date.parse(second?.updatedAt ?? '') || 0;

    if (secondTime !== firstTime) {
      return secondTime - firstTime;
    }

    return String(second?.code ?? '').localeCompare(String(first?.code ?? ''));
  });
}

export function upsertItem(items, nextItem) {
  const others = items.filter((item) => item.id !== nextItem.id);

  return sortItemsByUpdatedAt([nextItem, ...others]);
}
