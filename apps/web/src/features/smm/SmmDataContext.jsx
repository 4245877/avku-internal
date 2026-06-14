import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const STORAGE_KEY = 'avku-smm-data-v1';

const initialMaterials = [
  {
    id: 'material-1',
    description:
      'Роздача гуманітарної допомоги. Кадри черги та коротке інтерв’ю з координаторкою.',
    event: 'Гуманітарна допомога',
    shootingDate: '2026-06-12',
    author: 'Олена Коваль',
    permission: 'yes',
    driveUrl: 'https://drive.google.com/',
    mediaType: 'Фото і відео',
    fileNames: [],
    createdAt: '2026-06-12T15:20:00.000Z',
  },
  {
    id: 'material-2',
    description:
      'Підготовка волонтерів до виїзду, пакування аптечок і загальний план складу.',
    event: 'Волонтерський штаб',
    shootingDate: '2026-06-13',
    author: 'Марко Бойко',
    permission: 'unknown',
    driveUrl: 'https://drive.google.com/',
    mediaType: 'Фото',
    fileNames: [],
    createdAt: '2026-06-13T10:05:00.000Z',
  },
  {
    id: 'material-3',
    description: '',
    event: 'Навчання з домедичної допомоги',
    shootingDate: '2026-06-14',
    author: 'Ірина Савчук',
    permission: 'yes',
    driveUrl: '',
    mediaType: 'Відео',
    fileNames: [],
    createdAt: '2026-06-14T08:40:00.000Z',
  },
  {
    id: 'material-4',
    description:
      'Короткі відповіді учасників про те, чому вони долучилися до команди.',
    event: 'Знайомство з командою',
    shootingDate: '2026-06-11',
    author: 'Андрій Левченко',
    permission: 'no',
    driveUrl: 'https://drive.google.com/',
    mediaType: 'Відео',
    fileNames: [],
    createdAt: '2026-06-11T17:15:00.000Z',
  },
];

const initialPublications = [
  {
    id: 'publication-1',
    title: 'Як працює наш гуманітарний штаб',
    materialIds: ['material-1'],
    platform: 'Instagram',
    format: 'Reels',
    content:
      'Динамічний ролик до 45 секунд: черга, видача наборів, коментар координаторки та заклик підтримати наступний виїзд.',
    publishDate: '2026-06-16',
    status: 'Готово',
    createdAt: '2026-06-13T12:00:00.000Z',
  },
  {
    id: 'publication-2',
    title: 'Один день волонтерського штабу',
    materialIds: ['material-2'],
    platform: 'YouTube',
    format: 'Shorts',
    content:
      'Вертикальне відео про шлях аптечки від пакування до завантаження в авто.',
    publishDate: '2026-06-18',
    status: 'В роботі',
    createdAt: '2026-06-14T09:10:00.000Z',
  },
  {
    id: 'publication-3',
    title: 'П’ять правил домедичної допомоги',
    materialIds: ['material-3'],
    platform: 'Instagram',
    format: 'Stories',
    content: 'Серія з п’яти коротких карток із тезами інструктора.',
    publishDate: '2026-06-20',
    status: 'Ідея',
    createdAt: '2026-06-14T10:25:00.000Z',
  },
  {
    id: 'publication-4',
    title: 'Підсумки гуманітарного виїзду',
    materialIds: ['material-1'],
    platform: 'YouTube',
    format: 'Відео',
    content:
      'Повний сюжет із коментарем координаторки та ключовими цифрами виїзду.',
    publishDate: '2026-06-10',
    status: 'Опубліковано',
    createdAt: '2026-06-08T11:30:00.000Z',
  },
  {
    id: 'publication-5',
    title: 'Звіт за тиждень у цифрах',
    materialIds: ['material-1', 'material-2'],
    platform: 'Instagram',
    format: 'Пост',
    content:
      'Карусель із результатами роботи команди та подякою волонтерам.',
    publishDate: '2026-06-13',
    status: 'Опубліковано',
    createdAt: '2026-06-11T14:30:00.000Z',
  },
];

const SmmDataContext = createContext(null);

function loadStoredData() {
  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);

    if (!storedValue) {
      return null;
    }

    const parsedValue = JSON.parse(storedValue);

    if (
      !Array.isArray(parsedValue.materials) ||
      !Array.isArray(parsedValue.publications)
    ) {
      return null;
    }

    return parsedValue;
  } catch {
    return null;
  }
}

function createId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}`;
}

export function SmmDataProvider({ children }) {
  const [data, setData] = useState(() => {
    const storedData = loadStoredData();

    return (
      storedData ?? {
        materials: initialMaterials,
        publications: initialPublications,
      }
    );
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // The interface remains usable when browser storage is unavailable.
    }
  }, [data]);

  const addMaterial = useCallback((material) => {
    const newMaterial = {
      ...material,
      id: createId('material'),
      createdAt: new Date().toISOString(),
    };

    setData((currentData) => ({
      ...currentData,
      materials: [newMaterial, ...currentData.materials],
    }));

    return newMaterial;
  }, []);

  const addPublication = useCallback((publication) => {
    const newPublication = {
      ...publication,
      id: createId('publication'),
      createdAt: new Date().toISOString(),
    };

    setData((currentData) => ({
      ...currentData,
      publications: [newPublication, ...currentData.publications],
    }));

    return newPublication;
  }, []);

  const updatePublicationStatus = useCallback((publicationId, status) => {
    setData((currentData) => ({
      ...currentData,
      publications: currentData.publications.map((publication) =>
        publication.id === publicationId
          ? { ...publication, status }
          : publication,
      ),
    }));
  }, []);

  const value = useMemo(
    () => ({
      materials: data.materials,
      publications: data.publications,
      addMaterial,
      addPublication,
      updatePublicationStatus,
    }),
    [addMaterial, addPublication, data, updatePublicationStatus],
  );

  return (
    <SmmDataContext.Provider value={value}>
      {children}
    </SmmDataContext.Provider>
  );
}

export function useSmmData() {
  const context = useContext(SmmDataContext);

  if (!context) {
    throw new Error('useSmmData must be used inside SmmDataProvider');
  }

  return context;
}

