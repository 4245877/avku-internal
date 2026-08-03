/**
 * One self-saving write, with the four states it can be in.
 *
 * Every list section in the editor — an action, an issue, a task, a contact, an
 * assignment, a file — saves itself the moment its little form is submitted,
 * rather than waiting for the editor's «Зберегти». They are independent records
 * with their own identity, and holding a created task hostage to an unrelated
 * address edit would be surprising in both directions.
 *
 * Which means every one of them needs the same four guarantees, and getting
 * them subtly wrong seven times is how a form loses somebody's work:
 *
 *   • **success is never announced before the server answers.** The notice is
 *     set in the resolved branch, never optimistically.
 *   • **a second click cannot create a second record.** The guard is a ref, so
 *     it holds within one tick — a `disabled` prop only takes effect after the
 *     next render, which is one frame too late for a double tap.
 *   • **a failure keeps the form.** This hook never resets anything; the caller
 *     clears its fields only when `run` resolves truthy.
 *   • **the server's own message is what the user reads.** A 403 has to say
 *     "you do not have the rights for this", not "щось пішло не так".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a success line stays before it puts itself away. */
const NOTICE_TIMEOUT_MS = 4000;

export function useEditorMutation() {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  const isBusyRef = useRef(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      if (isMounted.current) {
        setNotice('');
      }
    }, NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [notice]);

  /**
   * Runs `operation` once. Resolves to the operation's result on success and
   * to `null` on failure, so a caller can write `if (await run(…))`.
   */
  const run = useCallback(async (operation, successMessage = '') => {
    if (isBusyRef.current) {
      return null;
    }

    isBusyRef.current = true;
    setIsBusy(true);
    setError(null);
    setNotice('');

    try {
      const result = await operation();

      if (isMounted.current) {
        setNotice(successMessage);
      }

      return result ?? true;
    } catch (caught) {
      if (isMounted.current) {
        setError(caught?.message ?? 'Не вдалося зберегти зміни.');
      }

      return null;
    } finally {
      isBusyRef.current = false;

      if (isMounted.current) {
        setIsBusy(false);
      }
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setNotice('');
  }, []);

  return { run, reset, isBusy, error, notice };
}
