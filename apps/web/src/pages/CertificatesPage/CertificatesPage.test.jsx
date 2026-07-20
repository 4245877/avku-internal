import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

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
  deleteCertificate: vi.fn(),
  renewCertificate: vi.fn(),
  downloadCertificate: vi.fn(),
  downloadBlob: vi.fn(),
  printCertificateSheet: vi.fn(),
}));

const { default: CertificatesPage } = await import('./CertificatesPage.jsx');

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
  requestedUrls = [];
  globalThis.Image = TestImage;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
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
