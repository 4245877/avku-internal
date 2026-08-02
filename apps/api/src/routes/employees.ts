import { type ServerResponse } from "node:http";

import { sendJson } from "../http/responses";
import type { Employee } from "../modules/employees/employee-records";
import { resolveViewer } from "../modules/elections/elections-access";

/**
 * `GET /api/me`. For an Access-authenticated caller it returns the resolved
 * employee; for trusted local (LAN) access it returns `{ email: null, local:
 * true }` so the UI can hide the account / logout affordances.
 *
 * The elections role is resolved here as well — including the dev-auth flag, so
 * a UI running against a development override says so on screen rather than
 * looking like a normal signed-in session.
 */
export function handleMeRequest(
  response: ServerResponse,
  employee: Employee | null,
): void {
  const viewer = resolveViewer({
    email: employee?.email ?? null,
    storedRole: employee?.role ?? null,
  });

  sendJson(
    response,
    200,
    employee
      ? {
          email: employee.email,
          name: employee.name,
          firstSeen: employee.firstSeen,
          electionsRole: viewer.role,
          isDevAuth: viewer.isDevAuth,
          isLocalAuth: viewer.isLocalAuth,
        }
      : {
          email: viewer.email,
          local: true,
          electionsRole: viewer.role,
          isDevAuth: viewer.isDevAuth,
          isLocalAuth: viewer.isLocalAuth,
        },
  );
}
