import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Ledger9ContractProviders,
  ProviderFailedError,
  TxFailedError,
} from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxRead } from "@midnight-ntwrk/midnight-js-types";

import { ShieldedPoolError, type Step, track } from "../../src/transaction.ts";

type Behaviour = () => Promise<unknown>;

const succeed: Behaviour = async () => ({});
const connectorError = (code: string) =>
  Object.assign(new Error(`The wallet said ${code}`), { type: "DAppConnectorAPIError", code, reason: code });

/** Providers whose steps succeed unless told otherwise, and that log which were called. */
function fakeProviders(steps: { prove?: Behaviour; balance?: Behaviour; submit?: () => Promise<string> } = {}) {
  const called: string[] = [];
  const providers = {
    config: { networkId: "undeployed", ttlSeconds: 60 },
    proofProvider: {
      supportedEras: ["v9"],
      proveTx: () => (called.push("prove"), (steps.prove ?? succeed)()),
    },
    walletProvider: {
      supportedEras: ["v9"],
      getCoinPublicKey: () => "coin",
      balanceTx: () => (called.push("balance"), (steps.balance ?? succeed)()),
    },
    midnightProvider: {
      supportedEras: ["v9"],
      submitTx: () => (called.push("submit"), (steps.submit ?? (async () => "tx-1"))()),
    },
  } as unknown as Ledger9ContractProviders;
  return { providers, called };
}

/**
 * Acts as midnight-js does for a call: prove, balance, submit, then wait for the network. It
 * rethrows a provider's failure as ProviderFailedError, which redacts the original.
 */
async function asMidnightJs(providers: Ledger9ContractProviders, afterSubmit: Behaviour = succeed) {
  const step = async <T,>(method: "proveTx" | "balanceTx" | "submitTx", run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ShieldedPoolError) throw new ProviderFailedError(method, "shield", error);
      throw new ProviderFailedError(method, "shield", new Error("redacted"));
    }
  };
  const tx = {} as never;
  await step("proveTx", () => providers.proofProvider.proveTx(tx));
  await step("balanceTx", () => providers.walletProvider.balanceTx(tx));
  const txId = await step("submitTx", () => providers.midnightProvider.submitTx(tx));
  await afterSubmit();
  return txId;
}

const failedOnChain = (status: "FailEntirely" | "FailFallible") =>
  new TxFailedError(
    "call",
    {
      era: "v9",
      status,
      txId: "tx-1",
      identifiers: ["tx-1"],
      txHash: "h",
      blockHash: "b",
      blockHeight: 1,
      blockTimestamp: 0,
    } as unknown as FinalizedTxRead,
    { circuitId: "shield" },
  );

async function outcome(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof ShieldedPoolError, `not a ShieldedPoolError: ${String(error)}`);
    return error;
  }
  assert.fail("the call didn't fail");
}

describe("transaction steps", () => {
  it("reports each step in order, with the id once it's submitted", async () => {
    const { providers } = fakeProviders();
    const steps: [Step, string?][] = [];
    const txId = await track(providers, { onStep: (step, id) => steps.push(id ? [step, id] : [step]) }, asMidnightJs);
    assert.equal(txId, "tx-1");
    assert.deepEqual(steps, [["proving"], ["balancing"], ["submitting"], ["submitted", "tx-1"]]);
  });

  it("leaves the rest of each provider as it was", async () => {
    const { providers } = fakeProviders();
    await track(providers, {}, async (observed) => {
      assert.deepEqual(observed.walletProvider.supportedEras, ["v9"]);
      assert.equal(observed.walletProvider.getCoinPublicKey(), "coin");
      assert.equal(observed.config, providers.config);
    });
  });

  it("isn't thrown off by a step callback that throws", async () => {
    const { providers } = fakeProviders();
    const onStep = () => {
      throw new Error("a bug in the caller");
    };
    assert.equal(await track(providers, { onStep }, asMidnightJs), "tx-1");
  });
});

describe("transaction outcomes", () => {
  it("fails, with the prover's own error, when proving fails", async () => {
    const cause = new Error("the proof server is down");
    const { providers } = fakeProviders({ prove: () => Promise.reject(cause) });
    const error = await outcome(track(providers, {}, asMidnightJs));
    assert.equal(error.outcome, "failed");
    assert.equal(error.cause, cause);
    assert.match(error.message, /before it was sent: the proof server is down/);
  });

  it("fails when the wallet declines to balance", async () => {
    const cause = connectorError("Rejected");
    const { providers, called } = fakeProviders({ balance: () => Promise.reject(cause) });
    const error = await outcome(track(providers, {}, asMidnightJs));
    assert.equal(error.outcome, "failed");
    assert.equal(error.cause, cause);
    assert.deepEqual(called, ["prove", "balance"]);
  });

  it("fails when the wallet refuses to send what it was handed", async () => {
    for (const code of ["Rejected", "PermissionRejected", "InvalidRequest"]) {
      const { providers } = fakeProviders({ submit: () => Promise.reject(connectorError(code)) });
      const error = await outcome(track(providers, {}, asMidnightJs));
      assert.equal(error.outcome, "failed", code);
      assert.match(error.message, /refused to send/);
    }
  });

  it("is unknown when submitting fails in a way that doesn't say whether it was sent", async () => {
    for (const cause of [connectorError("InternalError"), connectorError("Disconnected"), new Error("socket closed")]) {
      const { providers } = fakeProviders({ submit: () => Promise.reject(cause) });
      const error = await outcome(track(providers, {}, asMidnightJs));
      assert.equal(error.outcome, "unknown", cause.message);
      assert.equal(error.cause, cause);
    }
  });

  it("is unknown when the wallet sent it and then waiting for the network fails", async () => {
    const { providers } = fakeProviders();
    const lost = () => Promise.reject(new Error("the indexer went away"));
    const error = await outcome(track(providers, {}, (observed) => asMidnightJs(observed, lost)));
    assert.equal(error.outcome, "unknown");
    assert.match(error.message, /isn't known whether .* the indexer went away/);
  });

  it("fails when the network rejected the transaction entirely", async () => {
    const { providers } = fakeProviders();
    const recorded = failedOnChain("FailEntirely");
    const error = await outcome(track(providers, {}, (observed) => asMidnightJs(observed, () => Promise.reject(recorded))));
    assert.equal(error.outcome, "failed");
    assert.equal(error.cause, recorded);
    assert.match(error.message, /rejected the transaction \(FailEntirely\)/);
  });

  // Its guaranteed part took effect, so some of the transaction did happen.
  it("is unknown when the network applied only part of the transaction", async () => {
    const { providers } = fakeProviders();
    const recorded = failedOnChain("FailFallible");
    const error = await outcome(track(providers, {}, (observed) => asMidnightJs(observed, () => Promise.reject(recorded))));
    assert.equal(error.outcome, "unknown");
    assert.equal(error.cause, recorded);
    assert.match(error.message, /applied only part of the transaction \(FailFallible\)/);
  });
});

describe("aborting", () => {
  it("doesn't start when the signal has already been aborted", async () => {
    const { providers, called } = fakeProviders();
    const error = await outcome(track(providers, { signal: AbortSignal.abort() }, asMidnightJs));
    assert.equal(error.outcome, "failed");
    assert.deepEqual(called, []);
  });

  it("never asks the wallet to balance or send after an abort", async () => {
    const controller = new AbortController();
    const { providers, called } = fakeProviders({ prove: async () => controller.abort() });
    const error = await outcome(track(providers, { signal: controller.signal }, asMidnightJs));
    assert.equal(error.outcome, "failed");
    assert.match(error.message, /^Stopped before the wallet was asked to balance/);
    assert.deepEqual(called, ["prove"]);
  });

  it("never hands the transaction over after an abort, even once it's balanced", async () => {
    const controller = new AbortController();
    const { providers, called } = fakeProviders({ balance: async () => controller.abort() });
    const error = await outcome(track(providers, { signal: controller.signal }, asMidnightJs));
    assert.equal(error.outcome, "failed");
    assert.match(error.message, /^Stopped before the transaction was handed/);
    assert.deepEqual(called, ["prove", "balance"]);
  });

  it("changes nothing once the transaction has been handed over", async () => {
    const controller = new AbortController();
    const { providers } = fakeProviders({
      submit: async () => (controller.abort(), "tx-1"),
    });
    assert.equal(await track(providers, { signal: controller.signal }, asMidnightJs), "tx-1");
  });
});
