/**
 * Loading, saving and error state for the house dataset.
 *
 * The hook owns nothing but state transitions — every request goes through
 * `electionsApi`, so pointing the module at a real backend is a one-file change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

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

export function useHousesData() {
  const [state, setState] = useState(createInitialState);
  const [reloadToken, setReloadToken] = useState(0);
  const [savingHouseId, setSavingHouseId] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [isRefreshingFromOsm, setIsRefreshingFromOsm] = useState(false);

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

  /**
   * Pulls buildings for the current boundary straight from OpenStreetMap, for
   * when the shipped snapshot does not reach the newly traced territory. The
   * result replaces the dataset for this session only.
   */
  const refreshFromOsm = useCallback(async () => {
    setIsRefreshingFromOsm(true);

    try {
      const payload = await fetchHousesFromOsm();

      setState({
        status: 'ready',
        houses: payload.houses,
        streets: payload.streets,
        area: payload.area,
        coverage: payload.coverage,
        error: null,
      });

      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: error?.message ?? 'Не вдалося завантажити дані з OpenStreetMap.',
      }));

      return false;
    } finally {
      setIsRefreshingFromOsm(false);
    }
  }, []);

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
      isRefreshingFromOsm,
      savingHouseId,
      saveError,
      reload,
      refreshFromOsm,
      saveDetails,
      resetDemoData,
      dismissSaveError,
    }),
    [
      dismissSaveError,
      isRefreshingFromOsm,
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
