// Bundles the built SDK the way an application would and runs it in Chromium.
// Needs CHROME_BIN: npm run test:browser
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { build, type Plugin, preview } from "vite";
import wasmPlugin from "vite-plugin-wasm";

// Its types describe the module, but under NodeNext the default import is the function itself.
const wasm = wasmPlugin as unknown as () => Plugin;
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("CHROME_BIN is not set");

const root = import.meta.dirname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-pool-browser-"));
const publicDir = path.join(work, "public");
const outDir = path.join(work, "dist");

// The directories an application serves for contractKeys.
const artifacts = path.resolve(
  createRequire(import.meta.url).resolve(
    "@shieldedpools/contracts/artifacts/compiler/contract-manifest.json",
  ),
  "../..",
);
for (const dir of ["compiler", "keys", "zkir"]) {
  fs.cpSync(path.join(artifacts, dir), path.join(publicDir, "zk", dir), { recursive: true });
}

// A swap that rewrites the manifest too, so only the SDK's pinned hash can catch it.
fs.cpSync(path.join(publicDir, "zk"), path.join(publicDir, "zk-tampered"), { recursive: true });
fs.appendFileSync(path.join(publicDir, "zk-tampered/compiler/contract-manifest.json"), " ");

const config = {
  root,
  publicDir,
  configFile: false as const,
  logLevel: "warn" as const,
  plugins: [wasm()],
  resolve: { alias: { "@shieldedpools/sdk": path.resolve(root, "../../dist/index.js") } },
  build: { outDir, target: "esnext", chunkSizeWarningLimit: 100_000 },
};
await build(config);
const server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
const { port } = server.httpServer.address() as AddressInfo;

const { stdout } = await promisify(execFile)(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--virtual-time-budget=60000",
    "--dump-dom",
    `http://127.0.0.1:${port}/`,
  ],
  { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
);
await server.close();
fs.rmSync(work, { recursive: true, force: true });

const body = /<pre id="out">(.*?)<\/pre>/s.exec(stdout)?.[1] ?? "{}";
const page = JSON.parse(body.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Record<string, unknown>;

assert.equal(page.error, undefined, String(page.error));
assert.match(String(page.color), /^[0-9a-f]{64}$/);
assert.equal(page.coinKey, "00".repeat(32));
assert.ok(Number(page.proverKeyBytes) > 1_000_000);
assert.ok(Number(page.verifierKeyBytes) > 1_000);
assert.ok(Number(page.zkirBytes) > 100);
assert.notEqual(page.tampered, "accepted");
console.log("browser check passed:", JSON.stringify(page));
process.exit(0);
