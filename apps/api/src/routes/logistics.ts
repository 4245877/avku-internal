import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { LogisticsRepository } from "../modules/logistics/logistics-records";
import { readJsonBody } from "../http/body";
import { sendJson } from "../http/responses";

export async function handleLogisticsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: LogisticsRepository,
  pathname: string,
): Promise<void> {
  if (request.method === "GET" && pathname === "/api/logistics") {
    sendJson(
      response,
      200,
      await repository.list(),
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/logistics") {
    sendJson(
      response,
      201,
      await repository.create(
        await readJsonBody(request),
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/logistics/export.csv") {
    const content = await repository.exportCsv();
    const buffer = Buffer.from(`﻿${content}`, "utf8");

    response.writeHead(
      200,
      {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": buffer.length,
        "Content-Disposition": 'attachment; filename="logistics-transfers.csv"',
      },
    );
    response.end(buffer);
    return;
  }

  const logisticsActionMatch =
    /^\/api\/logistics\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);

  if (logisticsActionMatch) {
    const [, id, action] = logisticsActionMatch;

    if (request.method === "GET" && !action) {
      sendJson(
        response,
        200,
        await repository.get(id),
      );
      return;
    }

    if (request.method === "PUT" && !action) {
      sendJson(
        response,
        200,
        await repository.update(
          id,
          await readJsonBody(request),
        ),
      );
      return;
    }

    if (request.method === "DELETE" && !action) {
      await repository.remove(id);
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }

    if (request.method === "POST" && action === "events") {
      sendJson(
        response,
        201,
        await repository.addEvent(
          id,
          await readJsonBody(request),
        ),
      );
      return;
    }
  }

  sendJson(
    response,
    404,
    {
      error: "Маршрут не найден.",
    },
  );
}
