import { HttpError } from "./responses";

export function resolveErrorStatusCode(error: unknown): number {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  if (error instanceof Error && error.message.includes("не найден")) {
    return 404;
  }

  if (error instanceof Error && error.message.includes("не знайдено")) {
    return 404;
  }

  return 400;
}
