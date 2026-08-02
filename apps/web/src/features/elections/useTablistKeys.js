/**
 * Keyboard behaviour for a `role="tablist"`.
 *
 * A row of buttons with `role="tab"` announces itself as a tab strip, and a
 * screen-reader user is then entitled to the tab strip's keyboard contract:
 * arrows move between tabs, Home and End jump to the ends, and the strip is a
 * single stop in the tab order rather than seven. Without it the card's seven
 * sections had to be tabbed through one at a time to reach anything below them,
 * and the arrow keys — which is what somebody who has been told "this is a tab
 * list" will press — did nothing at all.
 *
 * Selection follows focus, which is the right choice here: every panel is
 * already loaded or loads on its own, so arrowing along the strip is how you
 * read it, not a commitment.
 */

import { useCallback, useRef } from 'react';

export function useTablistKeys(ids, activeId, onSelect) {
  const listRef = useRef(null);

  const onKeyDown = useCallback(
    (event) => {
      const keys = {
        ArrowRight: 1,
        ArrowDown: 1,
        ArrowLeft: -1,
        ArrowUp: -1,
      };

      let nextIndex = null;
      const current = ids.indexOf(activeId);

      if (event.key in keys) {
        // Wraps, as the pattern specifies: the end of the strip is not a wall.
        nextIndex = (current + keys[event.key] + ids.length) % ids.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = ids.length - 1;
      }

      if (nextIndex === null) {
        return;
      }

      event.preventDefault();
      onSelect(ids[nextIndex]);

      // Focus has to move with the selection or the next arrow press starts
      // from wherever the browser still thinks it is.
      const buttons = listRef.current?.querySelectorAll('[role="tab"]');

      buttons?.[nextIndex]?.focus();
    },
    [activeId, ids, onSelect],
  );

  /** Spread onto each tab: only the selected one is in the tab order. */
  const tabProps = useCallback(
    (id) => ({
      'aria-selected': activeId === id,
      role: 'tab',
      tabIndex: activeId === id ? 0 : -1,
      type: 'button',
    }),
    [activeId],
  );

  return { listRef, onKeyDown, tabProps };
}
