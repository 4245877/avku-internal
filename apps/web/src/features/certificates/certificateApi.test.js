import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateCertificate, createCertificate, fetchCertificates, updateCertificate } from './certificateApi.js';

const DRAFT = {
  id: 'draft-1', status: 'draft', fullName: 'Петренко Петро', certificateNumber: '222',
  issuedAt: null, validUntil: '2027-12-31', photoUrl: null,
  templateId: 'volunteer-card-v1-uk', exportUrls: { png: '', pdf: '' },
};

function mockResponse(payload, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('certificate draft API transport', () => {
  it('loads a draft without inventing a photo URL or export URL', async () => {
    mockResponse([DRAFT]);
    expect(await fetchCertificates()).toEqual([
      expect.objectContaining({ status: 'draft', issuedAt: null, photoUrl: '', exportUrls: { png: '', pdf: '' } }),
    ]);
  });

  it('sends explicit draft status and missing dates as null when creating without a photo', async () => {
    const fetchMock = mockResponse(DRAFT, 201);
    await createCertificate({
      status: 'draft', fullName: DRAFT.fullName, certificateNumber: DRAFT.certificateNumber,
      issuedAt: null, validUntil: DRAFT.validUntil,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/certificates');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toMatchObject({ status: 'draft', issuedAt: null });
    expect(JSON.parse(options.body)).not.toHaveProperty('photoDataUrl');
  });

  it('keeps draft status in the multipart request used to add a real photo', async () => {
    const fetchMock = mockResponse({ ...DRAFT, photoUrl: '/api/certificates/photos/portrait.png' });
    const photoFile = new File(['real photograph bytes'], 'portrait.png', { type: 'image/png' });
    await updateCertificate(DRAFT.id, {
      status: 'draft', fullName: DRAFT.fullName, certificateNumber: DRAFT.certificateNumber,
      issuedAt: '2026-02-01', validUntil: DRAFT.validUntil, photoFile,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/certificates/draft-1');
    expect(options.method).toBe('PUT');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('status')).toBe('draft');
    expect(options.body.get('issuedAt')).toBe('2026-02-01');
    expect(options.body.get('photo').name).toBe('portrait.png');
    expect(options.headers).not.toHaveProperty('Content-Type');
  });

  it('activates only via the dedicated explicit transition endpoint', async () => {
    const fetchMock = mockResponse({ ...DRAFT, status: 'active' });
    expect((await activateCertificate(DRAFT.id)).status).toBe('active');
    expect(fetchMock).toHaveBeenCalledWith('/api/certificates/draft-1/activate', expect.objectContaining({ method: 'PATCH' }));
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('reports an activation error from the API without a fabricated record', async () => {
    mockResponse({ error: 'Дата видачі та фото обов’язкові.' }, 400);
    await expect(activateCertificate(DRAFT.id)).rejects.toThrow('Дата видачі та фото обов’язкові.');
  });
});
