import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import PhotoCropper from './PhotoCropper.jsx';

const PHOTO_FRAME = {
  x: 566,
  y: 397,
  width: 377,
  height: 519,
  radius: 62,
  bleed: 2,
};
const CROP = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
};

const PHOTO_A = '/api/certificates/photos/a.jpg?w=1200';
const PHOTO_B = '/api/certificates/photos/b.jpg?w=1200';

/**
 * Every `new Image()` is captured so a test can decide when — and whether — each
 * individual load finishes, which is what makes switching order observable.
 */
let loads = [];

class TestImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
    this._src = '';
    loads.push(this);
  }

  set src(value) {
    this._src = value;
  }

  get src() {
    return this._src;
  }

  succeed(width = 1200, height = 1600) {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }

  fail() {
    this.onerror?.(new Event('error'));
  }
}

function pendingFor(url) {
  return loads.filter((load) => load.src === url);
}

async function resolveAll(url, outcome = 'succeed') {
  await act(async () => {
    pendingFor(url).forEach((load) => load[outcome]());
  });
}

function renderCropper(imageUrl) {
  return render(
    <PhotoCropper
      imageUrl={imageUrl}
      crop={CROP}
      photoFrame={PHOTO_FRAME}
      error=""
      onCropChange={() => {}}
      onPhotoChange={() => {}}
    />,
  );
}

function cropperImage() {
  return document.querySelector('img');
}

beforeEach(() => {
  loads = [];
  globalThis.Image = TestImage;
});

afterEach(() => {
  cleanup();
  loads = [];
});

describe('PhotoCropper', () => {
  it('renders the photo of the certificate it was given', async () => {
    renderCropper(PHOTO_A);
    await resolveAll(PHOTO_A);

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_A);
  });

  it('requests and shows the new photo when another certificate is selected', async () => {
    const { rerender } = renderCropper(PHOTO_A);
    await resolveAll(PHOTO_A);

    rerender(
      <PhotoCropper
        imageUrl={PHOTO_B}
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
      />,
    );

    expect(pendingFor(PHOTO_B)).toHaveLength(1);

    await resolveAll(PHOTO_B);

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_B);
    expect(screen.queryByText('Фото не вибрано')).toBeNull();
  });

  it('reports a photo that is still arriving as loading, not as missing', async () => {
    renderCropper(PHOTO_A);

    // Nothing has resolved yet: the frame is empty because the photo is in
    // flight, which must not read as "this record has no photo".
    expect(screen.getByText('Завантаження фото…')).toBeTruthy();
    expect(screen.queryByText('Фото не вибрано')).toBeNull();

    await resolveAll(PHOTO_A);

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_A);
  });

  it('distinguishes a failed photo from an absent one', async () => {
    renderCropper(PHOTO_A);
    await resolveAll(PHOTO_A, 'fail');

    expect(screen.getByText('Не вдалося завантажити фото')).toBeTruthy();
    expect(screen.queryByText('Фото не вибрано')).toBeNull();
  });

  it('says no photo is selected only when there is no photo', () => {
    renderCropper('');

    expect(screen.getByText('Фото не вибрано')).toBeTruthy();
  });

  it('recovers after the previously selected photo failed', async () => {
    const { rerender } = renderCropper(PHOTO_A);
    await resolveAll(PHOTO_A, 'fail');

    rerender(
      <PhotoCropper
        imageUrl={PHOTO_B}
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
      />,
    );
    await resolveAll(PHOTO_B);

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_B);
    expect(screen.queryByText('Не вдалося завантажити фото')).toBeNull();
  });

  it('keeps the current photo when a superseded one resolves late', async () => {
    const { rerender } = renderCropper(PHOTO_A);

    // Switch away before A has answered.
    rerender(
      <PhotoCropper
        imageUrl={PHOTO_B}
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
      />,
    );

    await resolveAll(PHOTO_B, 'succeed');
    // A only now comes back — and must not disturb B, whichever way it lands.
    await resolveAll(PHOTO_A, 'fail');

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_B);
    expect(screen.queryByText('Не вдалося завантажити фото')).toBeNull();
  });

  it('hands a dropped image file to onPhotoDrop', () => {
    const onPhotoDrop = vi.fn();
    render(
      <PhotoCropper
        imageUrl=""
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
        onPhotoDrop={onPhotoDrop}
      />,
    );

    const frame = screen.getByRole('application');
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: '' };

    fireEvent.dragOver(frame, { dataTransfer });
    fireEvent.drop(frame, { dataTransfer });

    expect(onPhotoDrop).toHaveBeenCalledTimes(1);
    expect(onPhotoDrop).toHaveBeenCalledWith(file);
  });

  it('ignores drags that carry no file', () => {
    const onPhotoDrop = vi.fn();
    render(
      <PhotoCropper
        imageUrl=""
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
        onPhotoDrop={onPhotoDrop}
      />,
    );

    const frame = screen.getByRole('application');
    const dataTransfer = { types: ['text/plain'], files: [], dropEffect: '' };

    fireEvent.dragOver(frame, { dataTransfer });
    fireEvent.drop(frame, { dataTransfer });

    expect(onPhotoDrop).not.toHaveBeenCalled();
  });

  it('does not let a late success from a previous photo set the wrong size', async () => {
    const { rerender } = renderCropper(PHOTO_A);

    rerender(
      <PhotoCropper
        imageUrl={PHOTO_B}
        crop={CROP}
        photoFrame={PHOTO_FRAME}
        error=""
        onCropChange={() => {}}
        onPhotoChange={() => {}}
      />,
    );

    await resolveAll(PHOTO_B, 'succeed');
    const widthAfterB = cropperImage()?.style.width;

    // A resolves late with very different dimensions.
    await act(async () => {
      pendingFor(PHOTO_A).forEach((load) => load.succeed(4000, 1000));
    });

    expect(cropperImage()?.getAttribute('src')).toBe(PHOTO_B);
    expect(cropperImage()?.style.width).toBe(widthAfterB);
  });
});
