import type { ConnectedAPI, KeyMaterialProvider } from "@midnightntwrk/dapp-connector-api";
import * as ledger from "@midnightntwrk/ledger-v9";
import { WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { DefaultForkSchedule } from "@midnightntwrk/wallet-sdk-facade";
import { hex } from "@scure/base";

import { parseShieldedAddress } from "../../src/address.ts";
import type { Network } from "../support/config.ts";
import { walletAddress } from "../support/transfers.ts";
import { settledState, syncedState, unwrapFinalized, type Wallet } from "../support/wallet.ts";

// Stands in for a browser wallet, backed by the SDK's Node wallet. It shows that the SDK's
// connector path works on a real chain with real proofs. It can't show that any real wallet
// behaves like this one: only the methods the SDK calls are here, and they act as a wallet
// could, not as one does.

type Recipe = Parameters<Wallet["facade"]["signRecipe"]>[0];

const V9 = DefaultForkSchedule.v9;
const TX_TTL_MS = 30 * 60 * 1000;

const ttl = () => new Date(Date.now() + TX_TTL_MS);

/** Proves with the keys the SDK hands over, as a wallet has to, rather than reading them itself. */
function provingProvider(proofServer: string, keys: KeyMaterialProvider) {
  // The SDK can't supply the ledger's own circuits, and the proof server has those already.
  const material = async (location: string) => {
    if (location.startsWith("midnight/")) return undefined;
    const [ir, proverKey, verifierKey] = await Promise.all([
      keys.getZKIR(location),
      keys.getProverKey(location),
      keys.getVerifierKey(location),
    ]);
    return { ir, proverKey, verifierKey };
  };
  const post = async (route: string, body: Uint8Array) => {
    const response = await fetch(new URL(route, proofServer), {
      method: "POST",
      body: new Uint8Array(body),
      headers: { "content-type": "application/octet-stream" },
    });
    if (!response.ok) throw new Error(`Proof server returned ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    check: async (preimage: Uint8Array, location: string) =>
      ledger.parseCheckResult(
        await post("/check", ledger.createCheckPayload(preimage, (await material(location))?.ir)),
      ),
    prove: async (preimage: Uint8Array, location: string, binding?: bigint) =>
      post("/prove", ledger.createProvingPayload(preimage, binding, await material(location))),
  };
}

export function fakeConnector(wallet: Wallet, network: Network): ConnectedAPI {
  const seal = async (recipe: Recipe) => {
    const signed = await wallet.facade.signRecipe(recipe, (payload) =>
      wallet.keystore.signDataAsync(payload),
    );
    return { tx: hex.encode(unwrapFinalized(await wallet.facade.finalizeRecipe(signed)).serialize()) };
  };

  const connector: Partial<ConnectedAPI> = {
    getConfiguration: async () => ({
      indexerUri: network.indexerHttp,
      indexerWsUri: network.indexerWs,
      substrateNodeUri: network.node,
      networkId: network.id,
    }),
    getShieldedAddresses: async () => {
      const { shielded } = await syncedState(wallet);
      return {
        shieldedAddress: MidnightBech32m.encode(network.id, shielded.address).asString(),
        shieldedCoinPublicKey: ShieldedCoinPublicKey.codec
          .encode(network.id, shielded.coinPublicKey)
          .asString(),
        shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec
          .encode(network.id, shielded.encryptionPublicKey)
          .asString(),
      };
    },
    getUnshieldedAddress: async () => {
      const { unshielded } = await syncedState(wallet);
      return { unshieldedAddress: MidnightBech32m.encode(network.id, unshielded.address).asString() };
    },
    getShieldedBalances: async () => (await syncedState(wallet)).shielded.balances,
    getUnshieldedBalances: async () => (await syncedState(wallet)).unshielded.balances,
    getDustBalance: async () => {
      const { dust } = await syncedState(wallet);
      return { cap: dust.balance(new Date()), balance: dust.balance(new Date()) };
    },
    getProvingProvider: async (keys) => provingProvider(network.proofServer, keys),
    balanceUnsealedTransaction: async (tx) => {
      await settledState(wallet);
      const unsealed = ledger.Transaction.deserialize(
        "signature",
        "proof",
        "pre-binding",
        hex.decode(tx),
      );
      return seal(
        await wallet.facade.balanceUnboundTransaction(WalletTransaction.adopt("Unbound", unsealed, V9), {
          ttl: ttl(),
        }),
      );
    },
    makeTransfer: async (outputs) => {
      await settledState(wallet);
      const transfers = outputs.map(({ type, value, recipient }) => ({
        type,
        amount: value,
        receiverAddress: walletAddress(parseShieldedAddress(recipient, network.id)),
      }));
      return seal(
        await wallet.facade.transferTransaction([{ type: "shielded", outputs: transfers }], {
          ttl: ttl(),
          payFees: true,
        }),
      );
    },
    submitTransaction: async (tx) => {
      const sealed = ledger.Transaction.deserialize("signature", "proof", "binding", hex.decode(tx));
      await wallet.facade.submitTransaction(WalletTransaction.adopt("Finalized", sealed, V9));
    },
  };
  return connector as ConnectedAPI;
}
