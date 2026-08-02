/**
 * Loads the records behind one house card tab.
 *
 * Each tab fetches its own collection, and only when it is first opened — the
 * card is the busiest screen in the module and a canvasser who wants to log a
 * visit should not wait for the file list. A `refreshToken` from the page
 * re-runs the fetch after any write, which is how a new action appears in the
 * log without a full reload.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  fetchHouseActions,
  fetchHouseAttachments,
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
  files: fetchHouseAttachments,
  history: fetchHouseHistory,
};

/**
 * @param {string|null} houseId
 * @param {string} collection  One of the keys of {@link LOADERS}.
 * @param {{campaignId?: string, enabled?: boolean, refreshToken?: number}} options
 */
export function useHouseRelated(houseId, collection, options = {}) {
  const { campaignId, enabled = true, refreshToken = 0 } = options;
  const [state, setState] = useState({ status: 'idle', items: [], error: null });

  const load = useCallback(
    (signal) => {
      const loader = LOADERS[collection];

      if (!loader || !houseId) {
        setState({ status: 'idle', items: [], error: null });

        return Promise.resolve();
      }

      setState((current) => ({ ...current, status: 'loading', error: null }));

      return loader(houseId, { campaignId, signal })
        .then((items) => {
          if (signal?.aborted) {
            return;
          }

          setState({ status: 'ready', items: items ?? [], error: null });
        })
        .catch((error) => {
          if (signal?.aborted || error?.name === 'AbortError') {
            return;
          }

          // A 403 here is not a bug — it is the answer for a tab the user is not
          // allowed to see, and it has to read as that rather than as a failure.
          setState({
            status: 'error',
            items: [],
            error: error?.message ?? 'Не вдалося завантажити дані.',
          });
        });
    },
    [campaignId, collection, houseId],
  );

  useEffect(() => {
    if (!enabled || !houseId) {
      return undefined;
    }

    const controller = new AbortController();

    load(controller.signal);

    return () => controller.abort();
  }, [enabled, houseId, load, refreshToken]);

  return {
    ...state,
    isLoading: state.status === 'loading',
    isReady: state.status === 'ready',
    reload: () => load(),
  };
}
