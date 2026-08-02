/**
 * The full record for the house that is currently open.
 *
 * The map payload deliberately does not carry it. Everything the card shows
 * beyond the address — the free-text summary, the priority reason, the access
 * note, who is responsible, which precinct the building belongs to, the last
 * action and whether this viewer may see contacts at all — used to be sent for
 * every house on the territory so that one of them could be opened. It is
 * fetched here instead, when somebody actually asks for it.
 *
 * Switching house cancels the request in flight. Without that, clicking down a
 * street leaves a queue of responses arriving in whatever order the network
 * chose, and the last one to land wins — which is not the same as the last one
 * asked for. The generation counter is what makes "answer for the house that is
 * open now" the only answer that can reach the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchHouse } from './electionsApi.js';

const IDLE = { status: 'idle', house: null, error: null };

export function useHouseDetails(houseId, { campaignId, refreshToken = 0 } = {}) {
  const [state, setState] = useState(IDLE);
  /** Which request is allowed to write to state — see the module comment. */
  const generation = useRef(0);

  useEffect(() => {
    if (!houseId) {
      generation.current += 1;
      setState(IDLE);

      return undefined;
    }

    const controller = new AbortController();
    generation.current += 1;
    const mine = generation.current;

    setState((current) => ({
      status: 'loading',
      // The previously loaded house is kept only when it is this house being
      // refreshed after a write; otherwise the card would briefly show one
      // building's notes under another building's address.
      house: current.house?.id === houseId ? current.house : null,
      error: null,
    }));

    fetchHouse(houseId, { campaignId, signal: controller.signal })
      .then((house) => {
        if (generation.current !== mine) {
          return;
        }

        setState({ status: 'ready', house, error: null });
      })
      .catch((error) => {
        if (generation.current !== mine || error?.name === 'AbortError') {
          return;
        }

        setState({
          status: 'error',
          house: null,
          error: error?.message ?? 'Не вдалося завантажити картку будинку.',
        });
      });

    return () => controller.abort();
  }, [campaignId, houseId, refreshToken]);

  const replace = useCallback((house) => {
    setState((current) =>
      current.house?.id === house?.id ? { ...current, house } : current,
    );
  }, []);

  return {
    ...state,
    isLoading: state.status === 'loading',
    isReady: state.status === 'ready',
    replace,
  };
}
