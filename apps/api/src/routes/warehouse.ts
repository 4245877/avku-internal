import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { WarehouseRepository } from "../modules/warehouse/warehouse-records";
import { readJsonBody } from "../http/body";
import { sendJson } from "../http/responses";

export async function handleWarehouseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: WarehouseRepository,
  pathname: string,
): Promise<void> {
  if (request.method === "GET" && pathname === "/api/warehouse") {
    sendJson(
      response,
      200,
      await repository.list(),
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/warehouse") {
    sendJson(
      response,
      201,
      await repository.create(
        await readJsonBody(request),
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/warehouse/export.csv") {
    const content = await repository.exportCsv();
    const buffer = Buffer.from(`﻿${content}`, "utf8");

    response.writeHead(
      200,
      {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": buffer.length,
        "Content-Disposition": 'attachment; filename="warehouse-stock.csv"',
      },
    );
    response.end(buffer);
    return;
  }

  const warehouseActionMatch =
    /^\/api\/warehouse\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);

  if (warehouseActionMatch) {
    const [, id, action] = warehouseActionMatch;

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

    if (request.method === "POST" && action === "movements") {
      sendJson(
        response,
        201,
        await repository.addMovement(
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
