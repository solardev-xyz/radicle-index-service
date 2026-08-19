/** Shared rad CLI invocation — one place for the env + timeout contract. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function execRad(
  radBin: string,
  radHome: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(radBin, args, {
    env: { ...process.env, RAD_HOME: radHome, RAD_PASSPHRASE: "" },
    timeout: timeoutMs,
  });
}
