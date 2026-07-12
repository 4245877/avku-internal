import { type ServerResponse } from "node:http";

import { sendJson } from "../http/responses";
import type { Employee } from "../modules/employees/employee-records";

/**
 * `GET /api/me`. For an Access-authenticated caller it returns the resolved
 * employee; for trusted local (LAN) access it returns `{ email: null, local:
 * true }` so the UI can hide the account / logout affordances.
 */
export function handleMeRequest(
  response: ServerResponse,
  employee: Employee | null,
): void {
  sendJson(
    response,
    200,
    employee
      ? {
          email: employee.email,
          name: employee.name,
          firstSeen: employee.firstSeen,
        }
      : {
          email: null,
          local: true,
        },
  );
}
