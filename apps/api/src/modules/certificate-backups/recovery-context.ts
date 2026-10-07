import path from "node:path";
import { mkdir } from "node:fs/promises";
import { copyPlain, copyTree } from "./files";

// Call only after verifyCapture. Build a disposable context with the original
// Docker COPY paths; never read the current repository or copy secrets.
export async function prepareRecoveryContext(payload: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  const recovery = path.join(payload, "recovery");
  await copyTree(path.join(recovery, "api-src"), path.join(destination, "apps/api/src"));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
    await copyPlain(path.join(recovery, name), path.join(destination, "apps/api", name));
  }
  await copyTree(path.join(recovery, "web"), path.join(destination, "apps/web"));
  await copyTree(path.join(payload, "templates"), path.join(destination, "storage/certificates/templates"));
  for (const [source, target] of [
    ["api.Dockerfile", "apps/api/Dockerfile"], ["web.Dockerfile", "apps/web/Dockerfile"],
    ["api-entrypoint.sh", "apps/api/docker-entrypoint.sh"], ["dockerignore", ".dockerignore"],
    ["extract.py", "infra/certificate-backup/extract.py"],
    ["fonts.conf", "infra/node/fonts.conf"], ["nginx/app.conf", "infra/nginx/app.conf"], ["nginx/web.conf", "infra/nginx/web.conf"],
  ]) await copyPlain(path.join(recovery, "deployment", source), path.join(destination, target));
}
