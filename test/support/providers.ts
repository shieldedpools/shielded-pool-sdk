import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import {
  NodeZkConfigProvider,
  nodeZkConfigRegistry,
} from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { createMidnightProvider, createWalletProvider } from "@midnight-ntwrk/midnight-js-types";
import { WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { DefaultForkSchedule } from "@midnightntwrk/wallet-sdk-facade";

import type { Network } from "./config.ts";
import { settledState, syncedState, unwrapFinalized, type Wallet } from "./wallet.ts";

const TX_TTL_SECONDS = 30 * 60;
const PROVE_TIMEOUT_MS = 15 * 60 * 1000;
const DUST_WAIT_MS = 10 * 60 * 1000;

export async function createProviders(
  wallet: Wallet,
  network: Network,
  zkDir: string,
  stateDir: string,
): Promise<ContractProviders> {
  const state = await syncedState(wallet);

  const walletProvider = createWalletProvider({
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    balanceTx: async (tx, ttl) => {
      const expires = ttl ?? new Date(Date.now() + TX_TTL_SECONDS * 1000);
      await settledState(wallet);
      const handle = WalletTransaction.adopt("Unbound", tx, DefaultForkSchedule.v9);
      await waitForFeeBudget(wallet, handle, expires);
      const recipe = await wallet.facade.balanceUnboundTransaction(handle, { ttl: expires });
      // `shield` spends the caller's NIGHT, so the balanced transaction needs their signature.
      const signed = await wallet.facade.signRecipe(recipe, (payload) =>
        wallet.keystore.signDataAsync(payload),
      );
      return unwrapFinalized(await wallet.facade.finalizeRecipe(signed));
    },
  });
  const midnightProvider = createMidnightProvider((finalized) =>
    wallet.facade.submitTransaction(
      WalletTransaction.adopt("Finalized", finalized, DefaultForkSchedule.v9),
    ),
  );

  fs.mkdirSync(stateDir, { recursive: true });
  const zkConfigProvider = new NodeZkConfigProvider<string>(zkDir);

  return {
    config: { networkId: network.id, ttlSeconds: TX_TTL_SECONDS },
    // Nothing here is secret. The contract has no witnesses, and the signing key midnight-js
    // stores on attach controls nothing, because the contract has no maintenance authority.
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: path.join(stateDir, "private-state"),
      privateStateStoreName: "shielded-pool",
      privateStoragePasswordProvider: () => "Shielded-pool-local-only1",
      accountId: state.shielded.encryptionPublicKey.toHexString().slice(0, 16),
    }),
    publicDataProvider: indexerPublicDataProvider(network.indexerHttp, network.indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider({
      url: network.proofServer,
      zkConfigProvider: await nodeZkConfigRegistry(path.dirname(zkDir)),
      timeout: PROVE_TIMEOUT_MS,
    }),
    walletProvider,
    midnightProvider,
  };
}

// DUST accrues over time, so a wallet that is short can simply wait for the fee.
async function waitForFeeBudget(
  wallet: Wallet,
  tx: Parameters<Wallet["facade"]["estimateTransactionFee"]>[0],
  ttl: Date,
): Promise<void> {
  const deadline = Date.now() + DUST_WAIT_MS;
  for (;;) {
    try {
      await wallet.facade.estimateTransactionFee(tx, { ttl });
      return;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/insufficient funds|could not balance dust/i.test(text)) throw error;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for DUST to pay the fee");
      console.log("Waiting for enough DUST to pay the fee...");
    }
    await delay(5_000);
  }
}
