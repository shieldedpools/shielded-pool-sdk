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

import type { Ledger9ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { SerializedContractState } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";

import { ZK_DIR } from "../support/config.ts";
import {
  immutability,
  isImmutable,
  shield,
  shieldToPerson,
  unshield,
  unshieldToPerson,
  wrappedColor,
} from "../../src/pool.ts";
import { ShieldedPoolError } from "../../src/transaction.ts";

const hex = () => randomBytes(32).toString("hex");

// These run the circuits without a proof or a network, so they check what the SDK hands the
// contract, not the proofs or the ledger.
const circuits = new Contract({});
const wallet = { bytes: randomBytes(32) };
const { currentContractState } = await circuits.initialState(createConstructorContext({}, wallet));
const poolAddress = sampleContractAddress();
const circuitContext = (circuitId: string) =>
  createCircuitContext({
    circuitId,
    contractAddress: poolAddress,
    coinPublicKeyOrZswapState: wallet,
    contractState: currentContractState,
    privateState: {},
  });

describe("tokens", () => {
  it("gives each token on each contract its own wrapped colour", () => {
    const [contract, other, token] = [hex(), hex(), hex()];
    assert.equal(wrappedColor(contract, token), wrappedColor(contract, token));
    assert.notEqual(wrappedColor(contract, token), wrappedColor(contract, hex()));
    assert.notEqual(wrappedColor(contract, token), wrappedColor(other, token));
  });

  // The colour the contract mints is what unshield compares a coin's colour against.
  it("names the colour the contract's shield circuit mints", async () => {
    const token = hex();
    const { result } = await circuits.circuits.shield(
      circuitContext("shield"),
      Buffer.from(token, "hex"),
      5n,
      randomBytes(32),
      shieldToPerson(wallet.bytes),
    );
    assert.equal(Buffer.from(result.color).toString("hex"), wrappedColor(poolAddress, token));
  });
});

// The two circuits put a person on opposite sides of their Eithers, so a swap would pay a
// contract, or be refused, instead of paying the person.
describe("recipients", () => {
  const token = randomBytes(32);

  it("mints to the person whose coin key it's given", async () => {
    const someone = randomBytes(32);
    const { context } = await circuits.circuits.shield(
      circuitContext("shield"),
      token,
      5n,
      randomBytes(32),
      shieldToPerson(someone),
    );
    const [output] = context.callContext.currentZswapLocalState?.outputs ?? [];
    assert.equal(output?.recipient.is_left, true);
    assert.deepEqual(Buffer.from(output!.recipient.left.bytes), someone);
  });

  it("releases the token to the user address it's given", async () => {
    const someone = randomBytes(32);
    const coin = {
      nonce: randomBytes(32),
      color: Buffer.from(wrappedColor(poolAddress, token.toString("hex")), "hex"),
      value: 5n,
    };
    const { context } = await circuits.circuits.unshield(circuitContext("unshield"), token, coin, unshieldToPerson(someone));
    const [[[, to]] = [[]]] = [...context.callContext.currentQueryContext.effects.claimedUnshieldedSpends];
    assert.deepEqual(to, { tag: "user", address: someone.toString("hex") });
  });

  it("leaves the side not taken as zeros, which is all the runtime accepts", () => {
    const zeros = new Uint8Array(32);
    assert.deepEqual(shieldToPerson(randomBytes(32)).right.bytes, zeros);
    assert.deepEqual(unshieldToPerson(randomBytes(32)).left.bytes, zeros);
  });
});

describe("arguments", () => {
  // Any use of these means a call got past its checks, which is what reaching the network takes.
  const TOUCHED = "touched the providers";
  const providers = new Proxy({}, {
    get() {
      throw new Error(TOUCHED);
    },
  }) as Ledger9ContractProviders;
  const [contract, token, recipient] = [hex(), hex(), randomBytes(32)];

  const refused = async (call: Promise<unknown>, reason: RegExp) => {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof ShieldedPoolError, String(error));
      assert.equal(error.outcome, "failed");
      assert.match(error.message, reason);
      return true;
    });
  };
  const passed = (call: Promise<unknown>) => assert.rejects(call, new RegExp(TOUCHED));

  it("refuses an amount the contract can't take, before reaching the network", async () => {
    for (const amount of [0n, -1n, 2n ** 64n, 5 as unknown as bigint]) {
      await refused(shield(providers, contract, token, amount), /amount/);
      await refused(unshield(providers, contract, token, amount, recipient), /amount/);
    }
  });

  it("takes any amount from 1 to the largest Uint<64>", async () => {
    for (const amount of [1n, 2n ** 64n - 1n]) {
      await passed(shield(providers, contract, token, amount));
      await passed(unshield(providers, contract, token, amount, recipient));
    }
  });

  it("refuses a token that isn't a colour", async () => {
    for (const bad of ["", "xyz", "ab".repeat(31), "ab".repeat(33), `0x${"ab".repeat(31)}`]) {
      await refused(shield(providers, contract, bad, 1n), /token/);
      await refused(unshield(providers, contract, bad, 1n, recipient), /token/);
    }
  });

  it("refuses a recipient that isn't 32 bytes, or is the zero address", async () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33), "ab".repeat(32) as unknown as Uint8Array]) {
      await refused(unshield(providers, contract, token, 1n, bad), /32 bytes/);
    }
    await refused(unshield(providers, contract, token, 1n, new Uint8Array(32)), /zero address/);
  });
});

describe("immutability", () => {
  const keys = (count: number) =>
    Array.from({ length: count }, () => ledger.signatureVerifyingKey(ledger.sampleSigningKey()));
  // What the indexer returns for a contract with this authority.
  const readOf = (committee: number, threshold: number) => {
    const state = new ledger.ContractState();
    state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority(keys(committee), threshold, 0n);
    return { protocolVersion: 0, contractState: SerializedContractState.fromBytes("v9", state.serialize()) };
  };
  const reading = (read: () => Promise<unknown>) =>
    ({ publicDataProvider: { queryContractState: read } }) as unknown as Ledger9ContractProviders;
  const contract = hex();

  it("calls a contract immutable when no committee can meet its threshold", async () => {
    const status = await immutability(reading(async () => readOf(0, 1)), contract);
    assert.equal(status.state, "immutable");
  });

  it("calls a contract changeable when its committee can sign, or when it needs no signature", async () => {
    for (const [committee, threshold] of [[1, 1], [3, 2], [0, 0]] as const) {
      const status = await immutability(reading(async () => readOf(committee, threshold)), contract);
      assert.equal(status.state, "changeable", `${threshold} of ${committee}`);
    }
  });

  it("is unreadable, never immutable, without a clear answer", async () => {
    const answers = [
      async () => null,
      async () => ({ protocolVersion: 0, contractState: { era: "v8" } }),
      async () => {
        throw new Error("the indexer went away");
      },
    ];
    for (const answer of answers) {
      assert.equal((await immutability(reading(answer), contract)).state, "unreadable");
    }
  });
});

describe("the immutability gate", () => {
  const { contract, token, recipient } = { contract: hex(), token: hex(), recipient: randomBytes(32) };
  // Anything past the gate needs these, so a call that reaches them got through it.
  const PAST_THE_GATE = "got past the gate";
  const past = () => {
    throw new Error(PAST_THE_GATE);
  };
  const providersReading = (read: () => Promise<unknown>) => {
    let reads = 0;
    const providers = {
      publicDataProvider: new Proxy({}, {
        get: (_, name) => (name === "queryContractState" && reads++ === 0 ? read : past()),
      }),
      proofProvider: { proveTx: past },
      walletProvider: { balanceTx: past },
      midnightProvider: { submitTx: past },
    } as unknown as Ledger9ContractProviders;
    return providers;
  };
  const authority = (committee: number, threshold: number) => async () => {
    const state = new ledger.ContractState();
    const keys = Array.from({ length: committee }, () => ledger.signatureVerifyingKey(ledger.sampleSigningKey()));
    state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority(keys, threshold, 0n);
    return { protocolVersion: 0, contractState: SerializedContractState.fromBytes("v9", state.serialize()) };
  };

  const refusal = async (call: Promise<unknown>, reason: RegExp) => {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof ShieldedPoolError);
      assert.equal(error.outcome, "failed");
      assert.match(error.message, /^Refusing to shield into this contract, because /);
      assert.match(error.message, reason);
      return true;
    });
  };
  const gotPast = (call: Promise<unknown>) =>
    assert.rejects(call, (error) => {
      assert.ok(error instanceof ShieldedPoolError);
      assert.doesNotMatch(error.message, /^Refusing/);
      return true;
    });

  it("refuses to shield into a contract its maintainers can change", async () => {
    await refusal(shield(providersReading(authority(1, 1)), contract, token, 1n), /1 of its 1 maintainers can change it/);
    await refusal(shield(providersReading(authority(0, 0)), contract, token, 1n), /anyone can change it/);
  });

  it("refuses to shield when the authority can't be read", async () => {
    const lost = async () => {
      throw new Error("the indexer went away");
    };
    await refusal(shield(providersReading(lost), contract, token, 1n), /couldn't be read: the indexer went away/);
  });

  it("lets a shield into an immutable contract through", async () => {
    await gotPast(shield(providersReading(authority(0, 1)), contract, token, 1n));
  });

  it("lets a shield through when told the contract may be changeable", async () => {
    const providers = providersReading(authority(1, 1));
    await gotPast(shield(providers, contract, token, 1n, { allowChangeable: true }));
  });

  // Leaving a contract someone could change is exactly what a holder should always be able to do.
  it("never stands in the way of an unshield", async () => {
    await gotPast(unshield(providersReading(authority(1, 1)), contract, token, 1n, recipient));
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
