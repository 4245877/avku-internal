/**
 * Loading, saving and error state for the house dataset.
 *
 * The hook owns nothing but state transitions — every request goes through
 * `electionsApi`, so pointing the module at a real backend is a one-file change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchHouses,
  getAreaMeta,
  resetHouseDetails,
  saveHouseDetails,
} from './electionsApi.js';
import { subscribeToWorkspaceArea } from './workspaceArea.js';

const initialState = {
  status: 'loading',
  houses: [],
  streets: [],
  area: getAreaMeta(),
  error: null,
};

export function useHousesData() {
  const [state, setState] = useState(initialState);
  const [reloadToken, setReloadToken] = useState(0);
  const [savingHouseId, setSavingHouseId] = useState(null);
  const [saveError, setSaveError] = useState(null);

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
      error: state.error,
      isLoading: state.status === 'loading',
      isReady: state.status === 'ready',
      hasError: state.status === 'error',
      savingHouseId,
      saveError,
      reload,
      saveDetails,
      resetDemoData,
      dismissSaveError,
    }),
    [dismissSaveError, reload, resetDemoData, saveDetails, saveError, savingHouseId, state],
  );
}
