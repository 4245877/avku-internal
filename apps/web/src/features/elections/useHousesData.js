/**
 * Loading, saving and error state for the house dataset.
 *
 * The hook owns nothing but state transitions — every request goes through
 * `electionsApi`, so pointing the module at a real backend is a one-file change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchHouses,
  fetchHousesFromOsm,
  getAreaMeta,
  resetHouseDetails,
  saveHouseDetails,
} from './electionsApi.js';
import { hydrateWorkspaceArea, subscribeToWorkspaceArea } from './workspaceArea.js';

/**
 * Built per mount rather than kept as a module constant: the working area can
 * change between two mounts of the page, and a shared object would open the
 * second one on the territory the first one started with.
 */
function createInitialState() {
  return {
    status: 'loading',
    houses: [],
    streets: [],
    area: getAreaMeta(),
    coverage: null,
    error: null,
  };
}

/**
 * Rounds of the Overpass mirror list a person is asked to sit through.
 *
 * The snapshot script can afford the client's default three rounds — nobody is
 * watching it — but here somebody is holding a banner open, and every extra
 * round adds its own back-off on top of four endpoint timeouts. Two rounds is
 * long enough to ride out one busy mirror and short enough to fail while the
 * question is still current; the refresh is cancellable either way.
 */
const OSM_REFRESH_ATTEMPTS = 2;

/** Nothing is being downloaded and nothing needs saying about it. */
const IDLE_REFRESH = { status: 'idle', error: null, houseCount: 0, progress: null };

export function useHousesData() {
  const [state, setState] = useState(createInitialState);
  const [reloadToken, setReloadToken] = useState(0);
  const [savingHouseId, setSavingHouseId] = useState(null);
  const [saveError, setSaveError] = useState(null);
  /**
   * The live refresh runs beside the dataset rather than inside it: it is one
   * banner's business, and a failed download must not take the houses already
   * on the map down with it.
   */
  const [osmRefresh, setOsmRefresh] = useState(IDLE_REFRESH);
  const osmRefreshRef = useRef(null);

  /*
   * The permanent boundary lives on the API; the first render used the local
   * cache so the map would not open on the wrong district while waiting. If the
   * two differ, applying the server's copy notifies the workspace store, which
   * reloads the dataset through the subscription below.
   */
  useEffect(() => {
    const controller = new AbortController();

    hydrateWorkspaceArea({ signal: controller.signal }).catch(() => {
      // A boundary that cannot be reconciled is not a reason to lose the map:
      // the cached territory stays in force and the dataset loads against it.
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;

    /*
     * A live download is always for the boundary that was in force when it
     * started, so a boundary that changes under it makes it the answer to a
     * question nobody asked any more — and its banner, success or failure,
     * would be about a territory that is no longer on screen.
     */
    osmRefreshRef.current?.abort();
    osmRefreshRef.current = null;
    setOsmRefresh(IDLE_REFRESH);

    setState((current) => ({ ...current, status: 'loading', error: null }));

    fetchHouses({ signal: controller.signal })
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setState({
          status: 'ready',
          houses: payload.houses,
          streets: payload.streets,
          area: payload.area,
          coverage: payload.coverage,
          error: null,
        });
      })
      .catch((error) => {
        if (!isActive || error?.name === 'AbortError') {
          return;
        }

        setState((current) => ({
          ...current,
          status: 'error',
          error: error?.message ?? 'Не вдалося завантажити дані будинків.',
        }));
      });

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  /*
   * The dataset is cut to the working area inside `electionsApi`, so a boundary
   * saved in the editor changes which houses exist — the list, the filters, the
   * counters and the territory's own metadata all have to be built again from
   * the new polygon.
   */
  useEffect(() => subscribeToWorkspaceArea(reload), [reload]);

  /** A download nobody is waiting for any more is stopped, not left running. */
  const cancelRefreshFromOsm = useCallback(() => {
    osmRefreshRef.current?.abort();
    osmRefreshRef.current = null;
    setOsmRefresh(IDLE_REFRESH);
  }, []);

  useEffect(() => () => osmRefreshRef.current?.abort(), []);

  /**
   * Pulls buildings for the current boundary straight from OpenStreetMap, for
   * when the shipped snapshot does not reach the newly traced territory.
   *
   * A failure is reported on the refresh itself and nowhere else: the map keeps
   * the houses, the border and the coverage banner it already had, and the
   * retry offered is the download that failed rather than a reload of the
   * snapshot that was never the problem.
   */
  const refreshFromOsm = useCallback(async () => {
    osmRefreshRef.current?.abort();

    const controller = new AbortController();
    osmRefreshRef.current = controller;

    setOsmRefresh({ ...IDLE_REFRESH, status: 'loading' });

    try {
      const payload = await fetchHousesFromOsm({
        signal: controller.signal,
        attempts: OSM_REFRESH_ATTEMPTS,
        onProgress: ({ round, attempts }) => {
          if (!controller.signal.aborted) {
            setOsmRefresh((current) =>
              current.status === 'loading' ? { ...current, progress: { round, attempts } } : current,
            );
          }
        },
      });

      if (controller.signal.aborted) {
        return false;
      }

      setState({
        status: 'ready',
        houses: payload.houses,
        streets: payload.streets,
        area: payload.area,
        coverage: payload.coverage,
        error: null,
      });

      setOsmRefresh({
        ...IDLE_REFRESH,
        status: 'success',
        houseCount: payload.houses.length,
      });

      return true;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        return false;
      }

      setOsmRefresh({
        ...IDLE_REFRESH,
        status: 'error',
        error: error?.message ?? 'Не вдалося завантажити дані з OpenStreetMap.',
      });

      return false;
    } finally {
      if (osmRefreshRef.current === controller) {
        osmRefreshRef.current = null;
      }
    }
  }, []);

  /** Puts the banner's confirmation away once it has been read. */
  const dismissOsmRefresh = useCallback(
    () => setOsmRefresh((current) => (current.status === 'idle' ? current : IDLE_REFRESH)),
    [],
  );

  /**
   * Saves one house's survey data. The house object is replaced but its
   * `footprint` array is reused, which keeps the map's projection cache warm.
   */
  const saveDetails = useCallback(async (houseId, details) => {
    setSavingHouseId(houseId);
    setSaveError(null);

    try {
      const result = await saveHouseDetails(houseId, details);

      setState((current) => ({
        ...current,
        houses: current.houses.map((house) =>
          house.id === houseId ? { ...house, details: result.details } : house,
        ),
      }));

      return true;
    } catch (error) {
      setSaveError(error?.message ?? 'Не вдалося зберегти зміни.');

      return false;
    } finally {
      setSavingHouseId(null);
    }
  }, []);

  const resetDemoData = useCallback(async () => {
    await resetHouseDetails();
    setSaveError(null);
    setReloadToken((current) => current + 1);
  }, []);

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  return useMemo(
    () => ({
      status: state.status,
      houses: state.houses,
      streets: state.streets,
      area: state.area,
      coverage: state.coverage,
      error: state.error,
      isLoading: state.status === 'loading',
      isReady: state.status === 'ready',
      hasError: state.status === 'error',
      /** The polygon holds ground the dataset was never downloaded for. */
      hasMissingCoverage: state.status === 'ready' && state.coverage?.isCovered === false,
      /** The territory is covered and genuinely holds no buildings. */
      isAreaEmpty:
        state.status === 'ready' &&
        state.houses.length === 0 &&
        state.coverage?.isCovered !== false,
      /** `idle` | `loading` | `success` | `error`, plus what each one needs. */
      osmRefresh,
      isRefreshingFromOsm: osmRefresh.status === 'loading',
      savingHouseId,
      saveError,
      reload,
      refreshFromOsm,
      cancelRefreshFromOsm,
      dismissOsmRefresh,
      saveDetails,
      resetDemoData,
      dismissSaveError,
    }),
    [
      cancelRefreshFromOsm,
      dismissOsmRefresh,
      dismissSaveError,
      osmRefresh,
      refreshFromOsm,
      reload,
      resetDemoData,
      saveDetails,
      saveError,
      savingHouseId,
      state,
    ],
  );
}
