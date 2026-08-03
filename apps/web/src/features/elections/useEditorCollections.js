/**
 * The records behind the editor's heavy sections, loaded one section at a time.
 *
 * Opening a house must not download its whole file. A building somebody has
 * worked for a year carries hundreds of actions, a change journal, uploaded
 * photographs and every task ever closed against it — and the section a person
 * opens first is almost always «Основне», which needs none of it. So each
 * collection is fetched the first time its section is opened and then kept, and
 * a section that is never opened costs nothing at all.
 *
 * Two things this hook exists to get right:
 *
 *   • **switching house cancels what is in flight.** Clicking down a street
 *     otherwise leaves a queue of responses arriving in whatever order the
 *     network chose, and the last to land wins — which is not the same as the
 *     last one asked for. A generation counter makes "the answer for the house
 *     that is open now" the only answer that can reach the screen.
 *   • **a write invalidates exactly what it touched.** Logging a visit reloads
 *     the actions, not the file list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchHouseActions,
  fetchHouseAttachments,
  fetchHouseEvents,
  fetchHouseHistory,
  fetchHouseIssues,
  fetchHousePeople,
  fetchHouseTasks,
} from './electionsApi.js';

const LOADERS = {
  people: fetchHousePeople,
  actions: fetchHouseActions,
  issues: fetchHouseIssues,
  tasks: fetchHouseTasks,
  events: fetchHouseEvents,
  files: fetchHouseAttachments,
  history: fetchHouseHistory,
};

const EMPTY = { status: 'idle', items: [], error: null };

export function useEditorCollections(houseId, { campaignId } = {}) {
  const [collections, setCollections] = useState({});

  /** Which house the in-flight requests belong to. See the module comment. */
  const generation = useRef(0);
  const controllers = useRef(new Set());
  /** Collections already requested for this house, so they load once. */
  const requested = useRef(new Set());

  const abortAll = useCallback(() => {
    for (const controller of controllers.current) {
      controller.abort();
    }

    controllers.current.clear();
  }, []);

  useEffect(() => {
    generation.current += 1;
    abortAll();
    requested.current = new Set();
    setCollections({});

    return abortAll;
  }, [abortAll, campaignId, houseId]);

  const load = useCallback(
    (collection) => {
      const loader = LOADERS[collection];

      if (!loader || !houseId) {
        return;
      }

      const controller = new AbortController();
      const mine = generation.current;

      controllers.current.add(controller);
      setCollections((current) => ({
        ...current,
        [collection]: {
          ...(current[collection] ?? EMPTY),
          status: 'loading',
          error: null,
        },
      }));

      loader(houseId, { campaignId, signal: controller.signal })
        .then((items) => {
          if (generation.current !== mine || controller.signal.aborted) {
            return;
          }

          setCollections((current) => ({
            ...current,
            [collection]: { status: 'ready', items: items ?? [], error: null },
          }));
        })
        .catch((caught) => {
          if (generation.current !== mine || controller.signal.aborted ||
            caught?.name === 'AbortError') {
            return;
          }

          // A 403 here is not a bug — it is the answer for a section this role
          // may not read, and it has to say so rather than look like a failure.
          setCollections((current) => ({
            ...current,
            [collection]: {
              status: 'error',
              items: [],
              error: caught?.message ?? 'Не вдалося завантажити дані.',
            },
          }));
        })
        .finally(() => controllers.current.delete(controller));
    },
    [campaignId, houseId],
  );

  /** Loads a collection unless it has already been asked for. */
  const open = useCallback(
    (collection) => {
      if (!LOADERS[collection] || requested.current.has(collection)) {
        return;
      }

      requested.current.add(collection);
      load(collection);
    },
    [load],
  );

  /**
   * Re-reads collections a write has just changed. Names them explicitly:
   * creating a task must not make the editor re-download the change journal.
   */
  const invalidate = useCallback(
    (...names) => {
      for (const collection of names.flat()) {
        if (!LOADERS[collection]) {
          continue;
        }

        // The history is the one collection every write touches, so it is
        // re-read only when it has actually been looked at.
        if (requested.current.has(collection)) {
          load(collection);
        }
      }
    },
    [load],
  );

  const get = useCallback(
    (collection) => collections[collection] ?? EMPTY,
    [collections],
  );

  return useMemo(
    () => ({ get, open, invalidate }),
    [get, invalidate, open],
  );
}
