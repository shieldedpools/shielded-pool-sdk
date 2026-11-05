import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { Contract } from "@shieldedpools/contracts";

import { ZK_DIR } from "../support/config.ts";
import { isImmutable, wrappedColor } from "../../src/pool.ts";

const hex = () => randomBytes(32).toString("hex");

describe("tokens", () => {
  it("gives each token on each contract its own wrapped colour", () => {
    const [contract, other, token] = [hex(), hex(), hex()];
    assert.equal(wrappedColor(contract, token), wrappedColor(contract, token));
    assert.notEqual(wrappedColor(contract, token), wrappedColor(contract, hex()));
    assert.notEqual(wrappedColor(contract, token), wrappedColor(other, token));
  });

  // Runs the circuit without a proof or a network, so this checks the colour the contract
  // mints, which is what unshield compares a coin's colour against.
  it("names the colour the contract's shield circuit mints", async () => {
    const contract = new Contract({});
    const wallet = { bytes: randomBytes(32) };
    const { currentContractState } = await contract.initialState(createConstructorContext({}, wallet));
    const address = sampleContractAddress();
    const token = hex();
    const context = createCircuitContext({
      circuitId: "shield",
      contractAddress: address,
      coinPublicKeyOrZswapState: wallet,
      contractState: currentContractState,
      privateState: {},
    });
    const { result } = await contract.circuits.shield(context, Buffer.from(token, "hex"), 5n, randomBytes(32));
    assert.equal(Buffer.from(result.color).toString("hex"), wrappedColor(address, token));
  });
});

describe("isImmutable", () => {
  const authority = (committee: string[], threshold: number) => ({ committee, threshold, counter: 0n });

  it("accepts a threshold no committee can meet", () => {
    assert.ok(isImmutable(authority([], 1)));
    assert.ok(isImmutable(authority([hex()], 2)));
  });

  it("refuses threshold 0, which lets anyone change the contract, even with no committee", () => {
    assert.ok(!isImmutable(authority([], 0)));
    assert.ok(!isImmutable(authority([hex()], 0)));
  });

  it("refuses any committee that can sign", () => {
    const key = hex();
    assert.ok(!isImmutable(authority([key], 1)));
    assert.ok(!isImmutable(authority([key, key, key], 2)));
  });
});

describe("contract package", () => {
  it("pins the manifest of the contract this SDK is locked to", () => {
    const manifest = fs.readFileSync(path.join(ZK_DIR, "compiler/contract-manifest.json"));
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/pool.ts"), "utf8");
    assert.ok(source.includes(`"${createHash("sha256").update(manifest).digest("hex")}"`));
  });

  it("has the keys and ZKIR for each circuit where the proof providers look", () => {
    const circuits = Object.keys(new Contract({}).circuits).toSorted();
    assert.deepEqual(circuits, ["shield", "unshield"]);
    for (const circuit of circuits) {
      for (const file of [`keys/${circuit}.prover`, `keys/${circuit}.verifier`, `zkir/${circuit}.bzkir`]) {
        assert.ok(fs.existsSync(path.join(ZK_DIR, file)), file);
      }
    }
  });
});
