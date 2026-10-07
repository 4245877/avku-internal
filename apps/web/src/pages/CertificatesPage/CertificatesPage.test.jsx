import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

function buildRecord(id, name, number, photoFileName) {
  return {
    id,
    fullName: name,
    firstNameEn: '',
    lastNameEn: '',
    certificateNumber: number,
    issuedAt: '2026-01-01',
    validUntil: '2027-01-01',
    templateId: 'volunteer-card-v1-uk',
    photoUrl: `/api/certificates/photos/${photoFileName}`,
    photoCrop: {
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-0${id.at(-1)}T00:00:00.000Z`,
    exportUrls: {
      png: '',
      pdf: '',
    },
  };
}

const RECORD_A = buildRecord('rec-1', 'Іваненко Іван Іванович', '001', 'a.jpg');
const RECORD_B = buildRecord('rec-2', 'Петренко Петро Петрович', '002', 'b.jpg');

const TEMPLATE = {
  id: 'volunteer-card-v1-uk',
  name: 'UA',
  locale: 'uk',
  isDefault: true,
  layout: {
    canvas: {
      width: 1004,
      height: 1358,
    },
    photo: {
      x: 566,
      y: 397,
      width: 377,
      height: 519,
      radius: 62,
      bleed: 2,
    },
    fields: {
      lastName: { x: 60, y: 500, width: 460, height: 48, fontSize: 40 },
      fullName: { x: 60, y: 560, width: 460, height: 40, fontSize: 30 },
      certificateNumber: { x: 60, y: 620, width: 460, height: 40, fontSize: 30 },
      issuedAt: { x: 60, y: 680, width: 460, height: 36, fontSize: 26 },
      validUntil: { x: 60, y: 730, width: 460, height: 36, fontSize: 26 },
    },
  },
  assets: {
    backgroundUrl: '/api/certificates/templates/volunteer-card-v1-uk/background.png',
    stampOverlayUrl: '/api/certificates/templates/volunteer-card-v1-uk/stamp-overlay.png',
  },
};

vi.mock('../../features/certificates/certificateApi.js', () => ({
  fetchCertificates: vi.fn(async () => [RECORD_A, RECORD_B]),
  fetchCertificateTemplates: vi.fn(async () => ({
    defaultId: 'volunteer-card-v1-uk',
    templates: [TEMPLATE],
  })),
  createCertificate: vi.fn(),
  updateCertificate: vi.fn(),
  activateCertificate: vi.fn(),
  deleteCertificate: vi.fn(),
  renewCertificate: vi.fn(),
  downloadCertificate: vi.fn(),
  downloadBlob: vi.fn(),
  printCertificateSheet: vi.fn(),
}));

const { default: CertificatesPage } = await import('./CertificatesPage.jsx');
const certificateApi = await import('../../features/certificates/certificateApi.js');

let requestedUrls = [];

class TestImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }

  set src(value) {
    this._src = value;
    requestedUrls.push(value);
    // Resolve on a later task, so "loading" is a state the test can observe.
    setTimeout(() => {
      this.naturalWidth = 1200;
      this.naturalHeight = 1600;
      this.onload?.();
    }, 0);
  }

  get src() {
    return this._src;
  }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function cropperPane() {
  return document.querySelector('section[aria-label="Фотографія"]');
}

async function openRecord(name) {
  const [openButton] = screen.getAllByRole('button', { name: new RegExp(name) });

  await act(async () => {
    openButton.click();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  certificateApi.fetchCertificates.mockResolvedValue([RECORD_A, RECORD_B]);
  requestedUrls = [];
  globalThis.Image = TestImage;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

it('contains no backup UI and makes no backup API request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    render(<CertificatesPage />);
    await flush();
    expect(screen.queryByRole('region', { name: 'Резервне копіювання' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Створити резервну копію' })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/certificates/backups'))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('CertificatesPage draft workflow', () => {
  const draft = {
    ...RECORD_A, id: 'draft-1', status: 'draft', fullName: 'Чернетко Петро Петрович',
    certificateNumber: '222', issuedAt: null, photoUrl: '',
  };
  const editor = () => screen.getByRole('region', { name: 'Редактор посвідчення' });
  const saveDraft = () => fireEvent.click(within(editor()).getByRole('button', { name: 'Зберегти чернетку' }));
  const activateDraft = () => fireEvent.click(within(editor()).getByRole('button', { name: 'Оформити посвідчення' }));

  it('creates a draft without photo or issued date through the editor', async () => {
    certificateApi.createCertificate.mockImplementation(async (payload) => ({
      ...draft, ...payload, issuedAt: null, validUntil: null,
    }));
    render(<CertificatesPage />);
    await flush();

    fireEvent.change(screen.getByLabelText('ПІБ'), { target: { value: draft.fullName } });
    fireEvent.change(screen.getByLabelText('Номер посвідчення'), { target: { value: draft.certificateNumber } });
    saveDraft();

    await waitFor(() => expect(certificateApi.createCertificate).toHaveBeenCalledOnce());
    expect(certificateApi.createCertificate.mock.calls[0][0]).toMatchObject({
      status: 'draft', issuedAt: null, validUntil: null,
      photoFile: undefined, photoDataUrl: undefined,
    });
    await waitFor(() => expect(screen.getByText('Чернетку збережено.')).toBeTruthy());
    expect(within(editor()).getByText('Чернетка')).toBeTruthy();
  });

  it('lists and filters drafts, opens one for editing and saves incomplete changes', async () => {
    certificateApi.fetchCertificates.mockResolvedValue([RECORD_A, draft]);
    certificateApi.updateCertificate.mockImplementation(async (id, payload) => ({
      ...draft, ...payload, id,
    }));
    render(<CertificatesPage />);
    await flush();

    fireEvent.change(screen.getByLabelText('Стан запису'), { target: { value: 'draft' } });
    expect(screen.queryByRole('button', { name: /Іваненко/ })).toBeNull();
    const registryArticle = screen.getByRole('button', { name: /Чернетко/ }).closest('article');
    expect(within(registryArticle).getByText('Чернетка')).toBeTruthy();
    for (const label of ['Подовжити', 'PNG', 'PDF']) {
      expect(within(registryArticle).getByRole('button', { name: label }).disabled).toBe(true);
    }
    expect(within(registryArticle).getByRole('checkbox').disabled).toBe(true);

    await openRecord('Чернетко');
    expect(screen.getByLabelText('ПІБ').value).toBe(draft.fullName);
    expect(editor().querySelector('input[placeholder="дд.мм.рррр"]').value).toBe('');
    expect(screen.getByText('Фото не вибрано')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ПІБ'), { target: { value: 'Чернетко Петро' } });
    saveDraft();

    await waitFor(() => expect(certificateApi.updateCertificate).toHaveBeenCalledOnce());
    expect(certificateApi.updateCertificate.mock.calls[0]).toEqual([
      draft.id, expect.objectContaining({ fullName: 'Чернетко Петро', status: 'draft', issuedAt: null }),
    ]);
    await waitFor(() => expect(screen.getByText('Чернетку збережено.')).toBeTruthy());
    expect(within(editor()).getByText('Чернетка')).toBeTruthy();
  });

  it('blocks incomplete activation without calling the activation API', async () => {
    certificateApi.fetchCertificates.mockResolvedValue([draft]);
    render(<CertificatesPage />);
    await flush();
    await openRecord('Чернетко');
    activateDraft();

    expect(certificateApi.activateCertificate).not.toHaveBeenCalled();
    expect(screen.getByText('Вкажіть дату видачі.')).toBeTruthy();
    expect(screen.getByText('Завантажте фотографію.')).toBeTruthy();
    expect(within(editor()).getByText('Чернетка')).toBeTruthy();
  });

  it('uploads a real photo, sets the date, saves the draft and then explicitly activates it', async () => {
    certificateApi.fetchCertificates.mockResolvedValue([draft]);
    let savedDraft;
    certificateApi.updateCertificate.mockImplementation(async (id, payload) => {
      savedDraft = { ...draft, ...payload, id, photoUrl: '/api/certificates/photos/uploaded.jpg' };
      return savedDraft;
    });
    certificateApi.activateCertificate.mockImplementation(async () => ({ ...savedDraft, status: 'active' }));
    render(<CertificatesPage />);
    await flush();
    await openRecord('Чернетко');

    const file = new File(['real photograph bytes'], 'portrait.png', { type: 'image/png' });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    await waitFor(() => expect(cropperPane().querySelector('img')?.getAttribute('src')).toContain('data:image/png;'));
    fireEvent.change(editor().querySelector('input[placeholder="дд.мм.рррр"]'), {
      target: { value: '01.02.2026' },
    });
    expect(within(editor()).getByRole('button', { name: 'Оформити посвідчення' }).disabled).toBe(true);
    saveDraft();
    await waitFor(() => expect(certificateApi.updateCertificate).toHaveBeenCalledOnce());
    expect(certificateApi.updateCertificate.mock.calls[0][1]).toMatchObject({
      status: 'draft', issuedAt: '2026-02-01', photoFile: file,
    });
    await waitFor(() => expect(within(editor()).getByRole('button', { name: 'Оформити посвідчення' }).disabled).toBe(false));
    expect(certificateApi.activateCertificate).not.toHaveBeenCalled();
    activateDraft();
    await waitFor(() => expect(certificateApi.activateCertificate).toHaveBeenCalledWith(draft.id));
    await waitFor(() => expect(screen.getByText('Посвідчення оформлено.')).toBeTruthy());
    expect(within(editor()).queryByText('Чернетка')).toBeNull();
    expect(within(editor()).queryByRole('button', { name: 'Оформити посвідчення' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'PNG' }).every((button) => !button.disabled)).toBe(true);
  });

  it('keeps the draft visible when the API rejects activation', async () => {
    const completedDraft = { ...draft, issuedAt: '2026-01-01', photoUrl: RECORD_A.photoUrl };
    certificateApi.fetchCertificates.mockResolvedValue([completedDraft]);
    certificateApi.activateCertificate.mockRejectedValue(new Error('API: потрібна ручна перевірка'));
    render(<CertificatesPage />);
    await flush();
    await openRecord('Чернетко');
    activateDraft();
    await waitFor(() => expect(screen.getByText('API: потрібна ручна перевірка')).toBeTruthy());
    expect(within(editor()).getByText('Чернетка')).toBeTruthy();
  });

  it('preserves active form validation when editing existing certificates', async () => {
    render(<CertificatesPage />);
    await flush();
    await openRecord('Іваненко');
    fireEvent.change(editor().querySelector('input[placeholder="дд.мм.рррр"]'), { target: { value: '' } });
    fireEvent.click(within(editor()).getByRole('button', { name: 'Зберегти зміни' }));
    expect(certificateApi.updateCertificate).not.toHaveBeenCalled();
    expect(screen.getByText('Вкажіть дату видачі.')).toBeTruthy();
    expect(within(editor()).queryByRole('button', { name: 'Оформити посвідчення' })).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CertificatesPage photo handling across records', () => {
  it('loads the matching photo for each certificate as the operator switches', async () => {
    render(<CertificatesPage />);
    await flush();

    await openRecord('Іваненко');

    expect(requestedUrls.some((url) => url.includes('/photos/a.jpg'))).toBe(true);
    expect(cropperPane()?.querySelector('img')?.getAttribute('src')).toContain('a.jpg');

    await openRecord('Петренко');

    // The switch must actually fetch the second record's photo, not reuse the first.
    expect(requestedUrls.some((url) => url.includes('/photos/b.jpg'))).toBe(true);
    expect(cropperPane()?.querySelector('img')?.getAttribute('src')).toContain('b.jpg');
    expect(screen.queryByText('Фото не вибрано')).toBeNull();
  });

  it('shows the original photo again when the operator returns to a record', async () => {
    render(<CertificatesPage />);
    await flush();

    await openRecord('Іваненко');
    await openRecord('Петренко');
    await openRecord('Іваненко');

    expect(cropperPane()?.querySelector('img')?.getAttribute('src')).toContain('a.jpg');
    expect(screen.queryByText('Фото не вибрано')).toBeNull();
  });

  it('never leaves the previous record’s photo in the form', async () => {
    render(<CertificatesPage />);
    await flush();

    await openRecord('Іваненко');
    await openRecord('Петренко');

    const sources = [...document.querySelectorAll('img')]
      .map((img) => img.getAttribute('src'))
      .filter((src) => src?.includes('/photos/'));

    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((src) => src.includes('b.jpg'))).toBe(true);
  });

  it('asks the API for an editor-sized photo rather than the stored original', async () => {
    render(<CertificatesPage />);
    await flush();

    await openRecord('Іваненко');

    const photoRequest = requestedUrls.find((url) => url.includes('/photos/a.jpg'));

    expect(photoRequest).toContain('w=');
  });
});
