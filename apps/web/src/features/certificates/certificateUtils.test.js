import { describe, expect, it } from 'vitest';

import { PHOTO_PREVIEW_WIDTH } from './certificateTypes.js';
import {
  buildCertificatePayload,
  createFormFromRecord,
  getCertificateStatus,
  getEmptyCertificateForm,
  getPhotoPreviewUrl,
  validateCertificateForm,
} from './certificateUtils.js';

describe('getPhotoPreviewUrl', () => {
  it('asks the API for an editor-sized copy of a stored photo', () => {
    expect(getPhotoPreviewUrl('/api/certificates/photos/a.jpg')).toBe(
      `/api/certificates/photos/a.jpg?w=${PHOTO_PREVIEW_WIDTH}`,
    );
  });

  it('keeps a photo that was just picked from disk untouched', () => {
    expect(getPhotoPreviewUrl('data:image/jpeg;base64,abc')).toBe(
      'data:image/jpeg;base64,abc',
    );
  });

  it('leaves an empty photo empty', () => {
    expect(getPhotoPreviewUrl('')).toBe('');
  });

  it('preserves an existing query string', () => {
    expect(getPhotoPreviewUrl('/api/certificates/photos/a.jpg?v=2', 800)).toBe(
      '/api/certificates/photos/a.jpg?v=2&w=800',
    );
  });

  it('does not rewrite URLs that are not stored photos', () => {
    expect(getPhotoPreviewUrl('https://example.test/photo.jpg')).toBe(
      'https://example.test/photo.jpg',
    );
  });

  it('gives absolute API photo URLs the same treatment', () => {
    expect(getPhotoPreviewUrl('https://internal.avku.org/api/certificates/photos/a.jpg', 600))
      .toBe('https://internal.avku.org/api/certificates/photos/a.jpg?w=600');
  });
});

describe('createFormFromRecord', () => {
  it('carries the selected record’s photo and drops any previous upload', () => {
    const form = createFormFromRecord({
      id: 'rec-2',
      fullName: 'Петренко Петро',
      certificateNumber: '002',
      issuedAt: '2026-01-01',
      validUntil: '2027-01-01',
      templateId: 'volunteer-card-v1-uk',
      photoUrl: '/api/certificates/photos/b.jpg',
      photoCrop: { zoom: 1.5, offsetX: 4, offsetY: 5, rotation: 0 },
      createdAt: '',
      updatedAt: '',
    });

    expect(form.photoUrl).toBe('/api/certificates/photos/b.jpg');
    // A stale data URL or File here would show the previous record's photo.
    expect(form.photoDataUrl).toBe('');
    expect(form.photoFile).toBeNull();
    expect(form.photoCrop).toEqual({ zoom: 1.5, offsetX: 4, offsetY: 5, rotation: 0 });
  });
});

describe('certificate drafts', () => {
  const incompleteDraft = () => ({
    ...getEmptyCertificateForm(),
    fullName: 'Петренко Петро',
    certificateNumber: '222',
  });

  it('starts a draft with no invented dates or photograph', () => {
    const form = incompleteDraft();
    expect(form.status).toBe('draft');
    expect(form.issuedAt).toBe('');
    expect(form.validUntil).toBe('');
    expect(form.photoUrl).toBe('');
    expect(validateCertificateForm(form)).toEqual({});
    expect(buildCertificatePayload(form)).toMatchObject({
      status: 'draft', issuedAt: null, validUntil: null, photoFile: undefined, photoDataUrl: undefined,
    });
  });

  it('opens nullable draft fields as empty editable form values', () => {
    expect(createFormFromRecord({
      ...incompleteDraft(), id: 'draft-1', issuedAt: null, validUntil: null, photoUrl: null,
    })).toMatchObject({ status: 'draft', issuedAt: '', validUntil: '', photoUrl: '' });
  });

  it('always identifies a draft as draft even with a future expiry', () => {
    expect(getCertificateStatus('2099-01-01', 'draft')).toEqual({ label: 'Чернетка', tone: 'draft' });
  });

  it('requires dates and a photograph for both activation and active records', () => {
    const draft = incompleteDraft();
    const expected = {
      issuedAt: 'Вкажіть дату видачі.',
      validUntil: 'Вкажіть дату завершення дії.',
      photo: 'Завантажте фотографію.',
    };
    expect(validateCertificateForm(draft, { forActivation: true })).toEqual(expected);
    expect(validateCertificateForm({ ...draft, status: 'active' })).toEqual(expected);
    expect(validateCertificateForm({ ...draft, status: undefined })).toEqual(expected);
  });

  it('allows absent English names in a draft but requires them on English activation', () => {
    const draft = { ...incompleteDraft(), templateId: 'volunteer-card-v1-en' };
    expect(validateCertificateForm(draft)).toEqual({});
    expect(validateCertificateForm(draft, { forActivation: true })).toHaveProperty('firstNameEn');
    expect(validateCertificateForm(draft, { forActivation: true })).toHaveProperty('lastNameEn');
  });

  it('validates supplied draft dates and preserves their ordering', () => {
    expect(validateCertificateForm({ ...incompleteDraft(), issuedAt: '2026-02-30' })).toHaveProperty('issuedAt');
    expect(validateCertificateForm({
      ...incompleteDraft(), issuedAt: '2026-03-01', validUntil: '2026-02-01',
    })).toHaveProperty('validUntil');
  });

  it('lets a draft retain one known date while leaving the other unknown', () => {
    expect(validateCertificateForm({ ...incompleteDraft(), issuedAt: '2026-01-01' })).toEqual({});
    expect(validateCertificateForm({ ...incompleteDraft(), validUntil: '2027-01-01' })).toEqual({});
    expect(validateCertificateForm({ ...incompleteDraft(), validUntil: 'invalid' })).toHaveProperty('validUntil');
  });

  it('accepts activation only after all necessary data is present', () => {
    expect(validateCertificateForm({
      ...incompleteDraft(), issuedAt: '2026-01-01', validUntil: '2027-01-01',
      photoUrl: '/api/certificates/photos/real-upload.jpg',
    }, { forActivation: true })).toEqual({});
  });
});
