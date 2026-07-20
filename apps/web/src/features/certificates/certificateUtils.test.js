import { describe, expect, it } from 'vitest';

import { PHOTO_PREVIEW_WIDTH } from './certificateTypes.js';
import { createFormFromRecord, getPhotoPreviewUrl } from './certificateUtils.js';

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
