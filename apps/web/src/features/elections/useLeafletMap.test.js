import { describe, expect, it } from 'vitest';

import { TILE_ERROR_THRESHOLD, foldTileStatus, fogGradientStops } from './useLeafletMap.js';

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

describe('area fog', () => {
  /* The regression this shape exists for: the mask used to end in a flat
   * rectangle, which at the widest zoom read as a dark square drawn around the
   * district. Nothing of it may survive to its own boundary. */
  it('has run out by the edge of the mask', () => {
    const stops = fogGradientStops();
    const last = stops.at(-1);

    expect(last.opacity).toBe(0);
    expect(last.offset).toBeCloseTo(1, 10);
  });

  /* The other half of the same rule: dimming that faded early would wash over
   * houses that are inside the territory and make them read as excluded. The
   * polygon is inscribed in its bounds, so the fade may not start before the
   * corner of those bounds. */
  it('is still at full strength past the furthest corner of the working area', () => {
    for (const padRatio of [0.3, 0.6, 1.2]) {
      const [first] = fogGradientStops(padRatio);
      const boundsCorner = Math.SQRT2 / (1 + 2 * padRatio);

      expect(first.opacity).toBe(1);
      expect(first.offset).toBeGreaterThanOrEqual(boundsCorner);
    }
  });

  it('never rises again once it starts falling', () => {
    const stops = fogGradientStops();

    for (const [index, stop] of stops.slice(1).entries()) {
      expect(stop.opacity).toBeLessThan(stops[index].opacity);
      expect(stop.offset).toBeGreaterThan(stops[index].offset);
    }
  });

  /* A ramp the eye can count steps in is a worse artefact than the square. */
  it('describes the falloff in enough steps to read as smooth', () => {
    expect(fogGradientStops().length).toBeGreaterThanOrEqual(5);
  });
});
