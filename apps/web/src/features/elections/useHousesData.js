/**
 * Loading, saving and error state for the house dataset.
 *
 * The hook owns nothing but state transitions — every request goes through
 * `electionsApi`. What changed with the backend is *what a save means*: a
 * mutation now returns the server's own copy of the house, including the
 * counters it derives (last action, open issues, overdue tasks), and that copy
 * replaces the local one. The client never computes those numbers itself, so it
 * cannot drift out of step with what a colleague sees.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ELECTIONS_SOURCE,
  IS_BACKEND_SOURCE,
  createAction as apiCreateAction,
  createHousePerson as apiCreatePerson,
  createIssue as apiCreateIssue,
  createTask as apiCreateTask,
  fetchHouse,
  fetchHouses,
  fetchHousesFromOsm,
  fetchViewer,
  getAreaMeta,
  readActiveCampaignId,
  saveHouseAttributes,
  saveHouseState,
  uploadAttachment as apiUploadAttachment,
  writeActiveCampaignId,
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
    campaign: null,
    campaigns: [],
    viewer: null,
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
  const [campaignId, setCampaignId] = useState(() => readActiveCampaignId());
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

  /*
   * Who the server thinks we are. Loaded separately from the dataset so that a
   * role can be shown (and write buttons hidden) even while the houses are
   * still coming in — and so a dev-auth session says so on screen.
   */
  useEffect(() => {
    if (!IS_BACKEND_SOURCE) {
      return undefined;
    }

    const controller = new AbortController();

    fetchViewer({ signal: controller.signal })
      .then((viewer) => setState((current) => ({ ...current, viewer })))
      .catch(() => {
        // An identity the API will not confirm is treated as no role at all.
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

    fetchHouses({ signal: controller.signal, campaignId })
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setState((current) => ({
          ...current,
          status: 'ready',
          houses: payload.houses,
          streets: payload.streets,
          area: payload.area,
          coverage: payload.coverage,
          campaign: payload.campaign ?? null,
          campaigns: payload.campaigns ?? [],
          viewer: payload.viewer ?? current.viewer,
          error: null,
        }));

        // The server decides which campaign a request without one lands in;
        // remembering its answer keeps the next reload on the same campaign.
        if (payload.campaign?.id && payload.campaign.id !== campaignId) {
          writeActiveCampaignId(payload.campaign.id);
        }
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
  }, [campaignId, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  /** Switches the campaign in view. Nothing about the houses themselves moves. */
  const selectCampaign = useCallback((nextCampaignId) => {
    writeActiveCampaignId(nextCampaignId);
    setCampaignId(nextCampaignId);
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

      setState((current) => ({
        ...current,
        status: 'ready',
        houses: payload.houses,
        streets: payload.streets,
        area: payload.area,
        coverage: payload.coverage,
        error: null,
      }));

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
   * Puts the server's copy of a house back into the list.
   *
   * The `footprint` array is reused when it is unchanged, which keeps Leaflet's
   * projection cache warm — a save re-styles one polygon instead of rebuilding
   * the district.
   */
  const replaceHouse = useCallback((house) => {
    setState((current) => ({
      ...current,
      houses: current.houses.map((existing) =>
        existing.id === house.id
          ? { ...house, footprint: existing.footprint ?? house.footprint }
          : existing,
      ),
    }));
  }, []);

  /** Re-reads one house after a write that changed its derived counters. */
  const refreshHouse = useCallback(
    async (houseId) => {
      if (!IS_BACKEND_SOURCE) {
        return null;
      }

      try {
        const house = await fetchHouse(houseId, { campaignId });

        replaceHouse(house);

        return house;
      } catch {
        // The write itself succeeded; a failed refresh only means the counters
        // are one reload stale, which is not worth an error banner.
        return null;
      }
    },
    [campaignId, replaceHouse],
  );

  /**
   * Runs one mutation with the shared saving/error state around it.
   *
   * Every write in the card goes through here, so "which house is saving" and
   * "what did the server refuse" have exactly one source — including the 403s,
   * which have to reach the user as a sentence about permissions.
   */
  const runMutation = useCallback(
    async (houseId, operation) => {
      setSavingHouseId(houseId);
      setSaveError(null);

      try {
        const result = await operation();

        return { ok: true, result };
      } catch (error) {
        setSaveError(error?.message ?? 'Не вдалося зберегти зміни.');

        return { ok: false, error };
      } finally {
        setSavingHouseId(null);
      }
    },
    [],
  );

  const saveAttributes = useCallback(
    async (houseId, patch) => {
      const outcome = await runMutation(houseId, () =>
        saveHouseAttributes(houseId, patch, { campaignId }),
      );

      if (outcome.ok) {
        replaceHouse(outcome.result);
      }

      return outcome.ok;
    },
    [campaignId, replaceHouse, runMutation],
  );

  const saveState = useCallback(
    async (houseId, patch) => {
      const outcome = await runMutation(houseId, () =>
        saveHouseState(houseId, patch, { campaignId }),
      );

      if (outcome.ok) {
        replaceHouse(outcome.result);
      }

      return outcome.ok;
    },
    [campaignId, replaceHouse, runMutation],
  );

  const addAction = useCallback(
    async (houseId, payload) => {
      const outcome = await runMutation(houseId, () =>
        apiCreateAction({ ...payload, houseId }, { campaignId }),
      );

      if (outcome.ok) {
        await refreshHouse(houseId);
      }

      return outcome.ok;
    },
    [campaignId, refreshHouse, runMutation],
  );

  const addIssue = useCallback(
    async (houseId, payload) => {
      const outcome = await runMutation(houseId, () =>
        apiCreateIssue({ ...payload, houseId }, { campaignId }),
      );

      if (outcome.ok) {
        await refreshHouse(houseId);
      }

      return outcome.ok;
    },
    [campaignId, refreshHouse, runMutation],
  );

  const addTask = useCallback(
    async (houseId, payload) => {
      const outcome = await runMutation(houseId, () =>
        apiCreateTask({ ...payload, houseId }, { campaignId }),
      );

      if (outcome.ok) {
        await refreshHouse(houseId);
      }

      return outcome.ok;
    },
    [campaignId, refreshHouse, runMutation],
  );

  const addPerson = useCallback(
    async (houseId, payload) => {
      const outcome = await runMutation(houseId, () =>
        apiCreatePerson(houseId, payload, { campaignId }),
      );

      if (outcome.ok) {
        await refreshHouse(houseId);
      }

      return outcome.ok;
    },
    [campaignId, refreshHouse, runMutation],
  );

  const addAttachment = useCallback(
    async (houseId, file, { kind = 'photo', note = '' } = {}) => {
      const outcome = await runMutation(houseId, () =>
        apiUploadAttachment(
          { file, ownerType: 'house', ownerId: houseId, houseId, kind, note },
          { campaignId },
        ),
      );

      return outcome.ok;
    },
    [campaignId, runMutation],
  );

  const dismissSaveError = useCallback(() => setSaveError(null), []);

  return useMemo(
    () => ({
      status: state.status,
      houses: state.houses,
      streets: state.streets,
      area: state.area,
      coverage: state.coverage,
      campaign: state.campaign,
      campaigns: state.campaigns,
      viewer: state.viewer,
      error: state.error,
      source: ELECTIONS_SOURCE,
      isBackend: IS_BACKEND_SOURCE,
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
      campaignId: state.campaign?.id ?? campaignId,
      reload,
      selectCampaign,
      refreshFromOsm,
      cancelRefreshFromOsm,
      dismissOsmRefresh,
      refreshHouse,
      saveAttributes,
      saveState,
      addAction,
      addIssue,
      addTask,
      addPerson,
      addAttachment,
      dismissSaveError,
    }),
    [
      addAction,
      addAttachment,
      addIssue,
      addPerson,
      addTask,
      campaignId,
      cancelRefreshFromOsm,
      dismissOsmRefresh,
      dismissSaveError,
      osmRefresh,
      refreshFromOsm,
      refreshHouse,
      reload,
      saveAttributes,
      saveError,
      saveState,
      savingHouseId,
      selectCampaign,
      state,
    ],
  );
}
