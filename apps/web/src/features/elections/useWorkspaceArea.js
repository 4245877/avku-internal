/**
 * React binding for the working-area store in `workspaceArea.js`.
 *
 * The territory changes rarely — only when a boundary is saved from the editor
 * — but when it does, the map overlays, the house dataset and the header
 * counters all have to follow it in the same commit. `useSyncExternalStore` is
 * exactly that contract: the store owns the polygon, every component that
 * depends on it re-renders from one notification.
 */

import { useSyncExternalStore } from 'react';

import { getWorkspaceArea, subscribeToWorkspaceArea } from './workspaceArea.js';

/** The territory in force, as a frozen object whose identity changes on save. */
export function useWorkspaceArea() {
  return useSyncExternalStore(subscribeToWorkspaceArea, getWorkspaceArea, getWorkspaceArea);
}
