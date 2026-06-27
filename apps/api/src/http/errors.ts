import { HttpError } from "./responses";

/**
 * Node's filesystem/network errors carry a string `code` (e.g. `ENOENT`) and a
 * `syscall`, and frequently embed absolute filesystem paths in their `message`
 * (and `path`) fields. Those must never reach the client. Curated application
 * errors are plain `new Error("localised message")` without a `syscall`, so the
 * presence of `syscall` reliably tells the two apart.
 */
interface NodeSystemError extends Error {
  code?: unknown;
  syscall?: unknown;
}

const GENERIC_ERROR_MESSAGE = "Ошибка обработки запроса.";
const NOT_FOUND_MESSAGE = "Ресурс не найден.";
const INVALID_BODY_MESSAGE = "Некорректное тело запроса.";

export interface SanitizedError {
  statusCode: number;
  message: string;
  /**
   * True when the original error message was suppressed (system/internal
   * failure). The dispatcher uses this to decide what to write to the logs.
   */
  internal: boolean;
}

function getSystemErrorCode(error: Error): string | undefined {
  const code = (error as NodeSystemError).code;

  return typeof code === "string" ? code : undefined;
}

function isNodeSystemError(error: Error): boolean {
  return typeof (error as NodeSystemError).syscall === "string";
}

function isNotFoundMessage(message: string): boolean {
  return (
    message.includes("не найден") ||
    message.includes("не знайдено") ||
    message.includes("not found")
  );
}

/**
 * Maps any thrown value to a client-safe status code and message. Errors whose
 * messages may reveal internals (absolute paths, SQL, stack details) are
 * collapsed into neutral messages and flagged as `internal` so the dispatcher
 * can keep the full error in the logs only.
 */
export function sanitizeError(error: unknown): SanitizedError {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      internal: error.statusCode >= 500,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      statusCode: 400,
      message: INVALID_BODY_MESSAGE,
      internal: false,
    };
  }

  if (error instanceof Error) {
    // Missing files/templates/assets surface as a clean 404 instead of leaking
    // the absolute path embedded in the underlying ENOENT message.
    if (getSystemErrorCode(error) === "ENOENT") {
      return {
        statusCode: 404,
        message: NOT_FOUND_MESSAGE,
        internal: true,
      };
    }

    // Curated, localized "not found" messages (records, templates) stay
    // informative and are safe to surface as-is.
    if (!isNodeSystemError(error) && isNotFoundMessage(error.message)) {
      return {
        statusCode: 404,
        message: error.message,
        internal: false,
      };
    }

    // Any other system error (EACCES, EISDIR, ENOTDIR, …) may carry an absolute
    // path or low-level detail, so never forward its message.
    if (isNodeSystemError(error)) {
      return {
        statusCode: 500,
        message: GENERIC_ERROR_MESSAGE,
        internal: true,
      };
    }

    // Remaining plain Errors are our own localized validation messages.
    return {
      statusCode: 400,
      message: error.message,
      internal: false,
    };
  }

  return {
    statusCode: 500,
    message: GENERIC_ERROR_MESSAGE,
    internal: true,
  };
}
