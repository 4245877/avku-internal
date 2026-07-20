import { useEffect, useState } from 'react';

const EMPTY_STATE = {
  status: 'empty',
  size: null,
};

/**
 * Loads a photo and reports both its intrinsic size and where the load got to.
 *
 * The cropper and the certificate preview both need the natural dimensions
 * before they can place the image, and both used to derive them with their own
 * copy of the same effect. Sharing one hook keeps their states in step and,
 * more importantly, makes "still loading" a state of its own: previously a
 * photo that had not arrived yet was indistinguishable from no photo at all, so
 * a slow record switch rendered the «Фото не вибрано» placeholder as if the
 * record had none.
 *
 * Each load is tied to the URL that started it — a response for a photo the
 * operator has already switched away from is dropped instead of overwriting the
 * state of the record now on screen.
 *
 * @param {string} imageUrl
 * @returns {{ status: 'empty'|'loading'|'ready'|'error', size: { width: number, height: number }|null }}
 */
export function usePhotoImage(imageUrl) {
  const [state, setState] = useState(EMPTY_STATE);

  useEffect(() => {
    if (!imageUrl) {
      setState(EMPTY_STATE);
      return undefined;
    }

    let isCurrent = true;
    const image = new Image();

    setState({
      status: 'loading',
      size: null,
    });

    image.onload = () => {
      if (!isCurrent) {
        return;
      }

      setState({
        status: 'ready',
        size: {
          width: image.naturalWidth,
          height: image.naturalHeight,
        },
      });
    };

    image.onerror = () => {
      if (!isCurrent) {
        return;
      }

      setState({
        status: 'error',
        size: null,
      });
    };

    image.src = imageUrl;

    return () => {
      isCurrent = false;
      image.onload = null;
      image.onerror = null;
      // Dropping the handlers stops a stale response from being *applied*, but
      // the download itself keeps running and keeps its connection. Switching
      // through a registry faster than the photos arrive then leaves every
      // abandoned load competing with the photo now on screen, which is starved
      // behind them and never appears — the frame stays on «Завантаження фото…»
      // until a reload cancels everything. Clearing `src` aborts the request, so
      // only the current record's photo is ever in flight. Handlers are already
      // detached above, so the abort cannot fire `onerror`.
      image.src = '';
    };
  }, [imageUrl]);

  return state;
}

export default usePhotoImage;
