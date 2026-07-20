/**
 * Records every certificate-photo request a page makes, with enough detail to
 * answer the question the investigation turns on: when the operator switches
 * away from a record, does the abandoned photo request keep occupying the
 * origin's connection pool, and does that delay the photo now on screen?
 *
 * Chromium fires `request` when the renderer initiates a load — before the
 * socket pool decides whether it may proceed — so the gap between `request` and
 * the first response byte is exactly the queueing delay we are looking for.
 */

const PHOTO_PATH = '/api/certificates/photos/';

/** Photo files are named `<recordId>-<uploadedAtMs>.<ext>`, so the record id is the UUID prefix. */
export function getRecordIdFromPhotoUrl(url) {
  const fileName = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i.exec(fileName);

  return match ? match[1] : null;
}

export function isPhotoRequest(url) {
  return String(url).includes(PHOTO_PATH);
}

export function attachPhotoNetworkRecorder(page) {
  const entries = [];
  const byRequest = new Map();
  const inFlight = new Set();
  const marks = [];
  const startedAt = Date.now();

  const now = () => Date.now() - startedAt;

  page.on('request', (request) => {
    if (!isPhotoRequest(request.url())) {
      return;
    }

    const entry = {
      recordId: getRecordIdFromPhotoUrl(request.url()),
      url: request.url(),
      startMs: now(),
      endMs: null,
      durationMs: null,
      status: null,
      outcome: 'pending',
      failure: null,
      // How many photo requests were already unfinished when this one started —
      // the queue this request had to get through.
      inFlightAtStart: inFlight.size,
      fromCache: false,
    };

    byRequest.set(request, entry);
    inFlight.add(request);
    entries.push(entry);
  });

  page.on('response', async (response) => {
    const entry = byRequest.get(response.request());

    if (!entry) {
      return;
    }

    entry.status = response.status();
    entry.fromCache = response.fromServiceWorker() || Boolean(response.request().timing()?.responseStart === -1);
  });

  page.on('requestfinished', (request) => {
    const entry = byRequest.get(request);

    if (!entry) {
      return;
    }

    inFlight.delete(request);
    entry.endMs = now();
    entry.durationMs = entry.endMs - entry.startMs;
    entry.outcome = 'finished';
  });

  page.on('requestfailed', (request) => {
    const entry = byRequest.get(request);

    if (!entry) {
      return;
    }

    inFlight.delete(request);
    entry.endMs = now();
    entry.durationMs = entry.endMs - entry.startMs;
    entry.outcome = 'failed';
    // Chromium reports an aborted load as net::ERR_ABORTED — that is how a
    // genuinely cancelled request is distinguished from one that ran to
    // completion after the operator had already moved on.
    entry.failure = request.failure()?.errorText ?? 'unknown';
  });

  return {
    entries,

    /** Timeline marker, so a request can be attributed to the switch that caused it. */
    mark(label) {
      marks.push({
        label,
        atMs: now(),
      });
    },

    marks,

    /** Photo requests still unfinished right now. */
    pending() {
      return [...inFlight].map((request) => byRequest.get(request));
    },

    peakInFlight() {
      return entries.reduce((peak, entry) => Math.max(peak, entry.inFlightAtStart + 1), 0);
    },

    /**
     * Requests that were still running when the operator had already switched
     * to another record — the abandoned loads hypothesis 8 is about.
     */
    stillRunningAt(atMs) {
      return entries.filter((entry) => entry.startMs <= atMs && (entry.endMs === null || entry.endMs > atMs));
    },

    toJSON() {
      return {
        startedAt: new Date(startedAt).toISOString(),
        marks,
        entries,
      };
    },
  };
}
