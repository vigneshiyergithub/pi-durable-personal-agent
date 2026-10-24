// Copies .env to the linked Railway service without printing any values. Local-only keys (DATA_DIR, PORT) are skipped:
// the container must keep DATA_DIR=/data, the volume. AUTH_TOKEN is never pushed: sign-in uses passkeys.
//   npm run push-env
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const SKIP = new Set(["DATA_DIR", "PORT", "AUTH_TOKEN"]);
const path = new URL("../.env", import.meta.url);
const text = readFileSync(path, "utf8");

const vars = Object.entries(parseEnv(text)).flatMap(([key, value]) =>
	SKIP.has(key) || !value?.trim() ? [] : [[key, value.trim()] as const],
);
const args = ["variables", "--skip-deploys", ...vars.flatMap(([key, value]) => ["--set", `${key}=${value}`])];
const result = spawnSync("railway", args, { stdio: ["inherit", "ignore", "inherit"] });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`set on Railway: ${vars.map(([key]) => key).join(", ")}`);
