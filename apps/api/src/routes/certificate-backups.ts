import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessContext } from "../http/access-auth";
import { HttpError, sendJson } from "../http/responses";
import type { BackupService } from "../modules/certificate-backups/service";

// The common authenticator represents trusted LAN access as null. Nginx keeps
// the public tunnel Host, so a missing external JWT must not use this fallback.
function trustedLan(request: IncomingMessage, service: BackupService | undefined): boolean {
  const host = request.headers.host?.split(":")[0];
  if (!host) return false;
  const octets = host.split(".").map(Number);
  const privateV4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (!privateV4 && host !== "localhost") return false;
  return [...(service?.origins ?? [])].some(origin => new URL(origin).hostname === host);
}

export function handleCertificateBackupRequest(request: IncomingMessage, response: ServerResponse, pathname: string, identity: AccessContext, service: BackupService | undefined): void {
  response.setHeader("Cache-Control", "no-store");
  if (!identity && !trustedLan(request, service)) throw new HttpError(401, "Для резервного копіювання увійдіть через Cloudflare Access.");
  if (!service) throw new HttpError(503, "Резервне копіювання ще не налаштоване.");
  if (request.method === "POST" && pathname === "/api/certificates/backups") {
    const origin = request.headers.origin;
    // Preserve CSRF protection for both existing Access and trusted LAN access.
    if (!origin || !service.origins.has(origin) || request.headers["x-avku-backup"] !== "manual" ||
        !String(request.headers["content-type"] ?? "").startsWith("application/json") ||
        (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      throw new HttpError(403, "Запускайте резервне копіювання з дозволеної сторінки застосунку.");
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") throw new HttpError(400, "Потрібен Idempotency-Key.");
    request.resume();
    const job = service.accept(identity?.email ?? "trusted-local", key);
    sendJson(response, 202, { job }); return;
  }
  if (request.method === "GET" && pathname === "/api/certificates/backups") {
    const jobs = service.store.list();
    sendJson(response, 200, { jobs, activeJob: service.store.active(), lastSuccessful: service.store.lastSuccessful(), ...service.store.slots() }, { cacheControl: "no-store" }); return;
  }
  const match = /^\/api\/certificates\/backups\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (request.method === "GET" && match) {
    let job;
    try { job = service.store.get(match[1]); } catch { throw new HttpError(400, "Некоректний job ID."); }
    if (!job) throw new HttpError(404, "Операцію не знайдено.");
    sendJson(response, 200, { job }, { cacheControl: "no-store" }); return;
  }
  throw new HttpError(404, "Маршрут резервного копіювання не знайдено.");
}
