import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const src = path.join(root, "src");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("public API", () => {
  it("leaves process globals alone", () => {
    const script = `
      import http from "node:http";
      const before = [globalThis.WebSocket, http.globalAgent, console.error];
      const sdk = await import("./src/index.ts");
      const after = [globalThis.WebSocket, http.globalAgent, console.error];
      if (before.some((value, index) => value !== after[index])) process.exit(1);
      console.log(Object.keys(sdk).join(" "));
    `;
    const exports = execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
      { encoding: "utf8", cwd: root },
    ).split(/\s+/);
    assert.deepEqual(exports.filter(Boolean).toSorted(), [
      "NIGHT",
      "connectorProviders",
      "contractKeys",
      "isImmutable",
      "locked",
      "maintenanceAuthority",
      "parseUnshieldedAddress",
      "shield",
      "unshield",
      "wrappedColor",
    ]);
  });

  it("keeps everything that needs Node out of what it publishes", () => {
    const nodeOnly = /^(node:|ws$|rxjs$|@midnightntwrk\/wallet-sdk-|@midnight-ntwrk\/midnight-js-(level|node-zk|http-client))/;
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      assert.equal(path.dirname(file), src, `${[...seen].join(" -> ")}`);
      const source = fs.readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(/^(?:import|export) (?!type )[^;]*? from "([^"]+)"/gms)) {
        assert.ok(!nodeOnly.test(specifier!), `${path.relative(src, file)} imports ${specifier}`);
        if (specifier!.startsWith(".")) visit(path.resolve(path.dirname(file), specifier!));
      }
    };
    visit(path.join(src, "index.ts"));
    assert.ok(seen.size > 3);
  });

  it("publishes one entry, with no binary", () => {
    assert.deepEqual(Object.keys(manifest.exports), [".", "./package.json"]);
    assert.equal(manifest.bin, undefined);
    assert.deepEqual(manifest.files, ["dist"]);
  });

  // A user-level scope mapping can write these into the lockfile, and CI has no token for them.
  it("locks nothing to GitHub Packages", () => {
    const lock = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
    assert.ok(!lock.includes("npm.pkg.github.com"));
  });

  it("depends on exactly what it imports", () => {
    const imported = new Set<string>();
    for (const file of fs.readdirSync(src)) {
      const source = fs.readFileSync(path.join(src, file), "utf8");
      for (const [, specifier] of source.matchAll(/ from "([^."][^"]*)"/g)) {
        imported.add(specifier!.split("/").slice(0, specifier!.startsWith("@") ? 2 : 1).join("/"));
      }
    }
    assert.deepEqual([...imported].toSorted(), Object.keys(manifest.dependencies).toSorted());
  });
});
