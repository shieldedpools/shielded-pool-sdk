import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

import * as Rx from "rxjs";
import { WebSocket } from "ws";

import * as ledger from "@midnightntwrk/ledger-v9";
import {
  NoOpTransactionHistoryStorage,
  ProtocolVersion,
  WalletTransaction,
} from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { DefaultForkSchedule, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

import type { Network } from "./config.ts";

const SYNC_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

type FinalizedTransaction = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>;

const V9 = DefaultForkSchedule.v9;
const V9_EPOCH = ProtocolVersion.epochOf(V9, V9);

function configureNodeNetworking() {
  // @ts-expect-error the wallet syncs over GraphQL subscriptions, which need a global WebSocket
  globalThis.WebSocket = WebSocket;

  // The indexer provider's fetch uses Node's global agents, and keep-alive sockets
  // make it fail with `Premature close` on Node 24. createRequire because an ESM
  // namespace object is frozen, so globalAgent cannot be assigned through one.
  const nodeRequire = createRequire(import.meta.url);
  const http = nodeRequire("node:http") as typeof import("node:http");
  const https = nodeRequire("node:https") as typeof import("node:https");
  http.globalAgent = new http.Agent({ keepAlive: false });
  https.globalAgent = new https.Agent({ keepAlive: false });
}

export interface Wallet {
  facade: WalletFacade;
  keys: ledger.ZswapSecretKeys;
  keystore: ReturnType<typeof createKeystore>;
}

export type WalletState = Rx.ObservedValueOf<ReturnType<WalletFacade["state"]>>;

export async function openWallet(network: Network, seedHex: string): Promise<Wallet> {
  configureNodeNetworking();
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(seedHex, "hex"));
  const keystore = createKeystore({ kind: "schnorr", secret: seeds.unshielded }, network.id);

  const facade = await WalletFacade.init({
    configuration: {
      networkId: network.id,
      indexerClientConnection: {
        indexerHttpUrl: network.indexerHttp,
        indexerWsUrl: network.indexerWs,
      },
      provingServerUrl: new URL(network.proofServer),
      relayURL: new URL(network.node.replace(/^http/, "ws")),
      // The local chainspec needs a wider margin to avoid fee changes between
      // balancing and submission.
      costParameters: { feeBlocksMargin: 100 },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(seeds.shielded),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSeed(seeds.dust, ledger.LedgerParameters.initialParameters().dust),
  });
  await facade.start(seeds);

  const wallet = { facade, keys: ledger.ZswapSecretKeys.fromSeed(seeds.shielded), keystore };
  await syncedState(wallet);
  return wallet;
}

function firstState(
  wallet: Pick<Wallet, "facade">,
  ready: (state: WalletState) => boolean,
  timeout: number,
  failure: string,
): Promise<WalletState> {
  return Rx.firstValueFrom(
    wallet.facade.state().pipe(
      Rx.filter(ready),
      Rx.timeout({ first: timeout, with: () => Rx.throwError(() => new Error(failure)) }),
    ),
  );
}

export function syncedState(wallet: Wallet): Promise<WalletState> {
  return firstState(
    wallet,
    (state) => state.isSynced,
    SYNC_TIMEOUT_MS,
    "Timed out syncing the wallet",
  );
}

/**
 * The wallet's state once its own spends have come back from the chain. Until then it is
 * working from a view of its coins that the chain has moved past, so wait for this before
 * building another transaction that pays DUST.
 */
export function settledState(wallet: Pick<Wallet, "facade">): Promise<WalletState> {
  return firstState(
    wallet,
    ({ isSynced, shielded, unshielded, dust }) =>
      isSynced &&
      shielded.pendingCoins.length === 0 &&
      unshielded.pendingCoins.length === 0 &&
      dust.pendingCoins.length === 0,
    SETTLE_TIMEOUT_MS,
    "Timed out waiting for this wallet's transactions to settle",
  );
}

export function unwrapFinalized(
  handle: Parameters<typeof WalletTransaction.unwrapWithin>[0],
): FinalizedTransaction {
  const unwrapped = WalletTransaction.unwrapWithin<FinalizedTransaction>(handle, V9_EPOCH);
  if (unwrapped._tag === "Left") throw unwrapped.left;
  return unwrapped.right;
}

/** The 32 bytes a contract sees as this wallet's `UserAddress`. */
export function userAddressBytes(wallet: Wallet): Uint8Array {
  return ledger.encodeUserAddress(wallet.keystore.getAddress());
}
