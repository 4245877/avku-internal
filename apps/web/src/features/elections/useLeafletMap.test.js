import { describe, expect, it } from 'vitest';

import { TILE_ERROR_THRESHOLD, foldTileStatus } from './useLeafletMap.js';

const layer = (pending = 0, failed = 0) => ({ pending, failed });

describe('tile health', () => {
  it('is ready when every layer has finished', () => {
    expect(foldTileStatus([layer(), layer()])).toBe('ready');
  });

  it('is loading while any layer still has a batch in flight', () => {
    expect(foldTileStatus([layer(0), layer(1)])).toBe('loading');
  });

  /* The bug this function exists for: Leaflet fires `load` at the end of a
   * batch even when every tile in it failed, so a finished-but-failed layer
   * used to report itself ready and the error banner never appeared. */
  it('stays in error when a failed batch finishes loading', () => {
    expect(foldTileStatus([layer(0, TILE_ERROR_THRESHOLD)])).toBe('error');
  });

  it('outranks a healthy layer that is still loading', () => {
    expect(foldTileStatus([layer(2, 0), layer(0, TILE_ERROR_THRESHOLD)])).toBe('error');
  });

  /* One tile missing at the edge of a provider's coverage is normal. */
  it('ignores failures below the threshold', () => {
    expect(foldTileStatus([layer(0, TILE_ERROR_THRESHOLD - 1)])).toBe('ready');
  });

  it('reports the failure of either half of a hybrid mode', () => {
    const imagery = layer(0, 0);
    const labels = layer(0, TILE_ERROR_THRESHOLD);

    expect(foldTileStatus([imagery, labels])).toBe('error');
    expect(foldTileStatus([labels, imagery])).toBe('error');
  });
});
