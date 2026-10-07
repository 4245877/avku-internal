import { spawn } from "node:child_process";

export async function run(command: string, args: string[], input?: string, timeout = 1_800_000, env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.on("error", () => { clearTimeout(timer); reject(new Error("SUBPROCESS_UNAVAILABLE")); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("SUBPROCESS_FAILED")); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
