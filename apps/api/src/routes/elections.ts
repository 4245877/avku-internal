import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { Employee } from "../modules/employees/employee-records";
import type { WorkspaceAreaRepository } from "../modules/elections/workspace-area-records";
import { readJsonBody } from "../http/body";
import { sendJson } from "../http/responses";

/**
 * `/api/elections/area` — the working-area boundary of the "Вибори" module.
 *
 * `GET` answers 404 when nothing is saved, which is not an error: it is how the
 * client learns that the boundary shipped in the repository is the current
 * territory, and that a local cache left over from an earlier session should be
 * dropped rather than kept.
 */
export async function handleElectionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: WorkspaceAreaRepository,
  pathname: string,
  employee: Employee | null,
): Promise<void> {
  if (pathname === "/api/elections/area") {
    if (request.method === "GET") {
      const stored = await repository.read();

      if (!stored) {
        sendJson(
          response,
          404,
          {
            error: "Збереженої межі немає — діє межа з репозиторію.",
          },
        );
        return;
      }

      sendJson(
        response,
        200,
        stored,
      );
      return;
    }

    if (request.method === "PUT" || request.method === "POST") {
      const body = await readJsonBody(request);
      // The editor sends `{ area }`; a bare GeoJSON document is accepted too,
      // so the boundary can be published with a plain `curl -d @file`.
      const payload = "area" in body ? body.area : body;

      sendJson(
        response,
        200,
        await repository.save(
          payload,
          employee?.email ?? null,
        ),
      );
      return;
    }

    if (request.method === "DELETE") {
      await repository.clear();
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }
  }

  sendJson(
    response,
    404,
    {
      error: "Маршрут не знайдено.",
    },
  );
}
