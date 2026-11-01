import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";
import * as ledger from "@midnightntwrk/ledger-v9";
import type { ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { dappConnectorProofProvider } from "@midnight-ntwrk/midnight-js-dapp-connector-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  createMidnightProvider,
  createWalletProvider,
  type PrivateStateProvider,
  type ZKConfigProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { hex } from "@scure/base";

import { parseShieldedAddress } from "./address.ts";

// A connected wallet holds the keys, proves, balances and signs. This side never sees a seed or a
// secret key, and only reaches the wallet through the connector API.

const TX_TTL_SECONDS = 30 * 60;

type SealedTransaction = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>;

const toHex = (tx: { serialize(): Uint8Array }) => hex.encode(tx.serialize());

function deserializeSealed(tx: string): SealedTransaction {
  return ledger.Transaction.deserialize("signature", "proof", "binding", hex.decode(tx));
}

// midnight-js wants a transaction's id, but the connector's submit returns nothing.
function transactionId(tx: SealedTransaction): string {
  const id = tx.identifiers().at(-1);
  if (id === undefined) throw new Error("The wallet returned a transaction with no identifier");
  return id;
}

async function submit(connected: ConnectedAPI, tx: SealedTransaction): Promise<string> {
  await connected.submitTransaction(toHex(tx));
  return transactionId(tx);
}

// The contract has no witnesses, so its private state is always empty. midnight-js also makes a
// signing key whenever it attaches, but the contract has no maintenance committee for it to be on,
// so it controls nothing and doesn't need to outlive this object. A connected wallet never deploys.
function emptyPrivateState(): PrivateStateProvider {
  const states = new Map<string, unknown>();
  const signingKeys = new Map<string, unknown>();
  const unsupported = async (): Promise<never> => {
    throw new Error("A connected wallet has no private state to export or import");
  };
  return {
    setContractAddress: () => undefined,
    set: async (id: string, state: unknown) => void states.set(id, state),
    get: async (id: string) => states.get(id) ?? null,
    remove: async (id: string) => void states.delete(id),
    clear: async () => states.clear(),
    setSigningKey: async (address: string, key: unknown) => void signingKeys.set(address, key),
    getSigningKey: async (address: string) => signingKeys.get(address) ?? null,
    removeSigningKey: async (address: string) => void signingKeys.delete(address),
    clearSigningKeys: async () => signingKeys.clear(),
    exportPrivateStates: unsupported,
    importPrivateStates: unsupported,
    exportSigningKeys: unsupported,
    importSigningKeys: unsupported,
  } as unknown as PrivateStateProvider;
}

/** Providers for `shield`, `unshield` and `attach` that go through a connected wallet. */
export async function connectorProviders(
  connected: ConnectedAPI,
  zkConfigProvider: ZKConfigProvider<string>,
): Promise<ContractProviders> {
  const { indexerUri, indexerWsUri, networkId } = await connected.getConfiguration();
  // The connector gives its public keys in Bech32m and midnight-js wants hex.
  const { shieldedAddress } = await connected.getShieldedAddresses();
  const keys = parseShieldedAddress(shieldedAddress, networkId);
  const costModel = ledger.CostModel.initialCostModel();

  return {
    config: { networkId, ttlSeconds: TX_TTL_SECONDS },
    privateStateProvider: emptyPrivateState(),
    publicDataProvider: indexerPublicDataProvider(indexerUri, indexerWsUri),
    zkConfigProvider,
    proofProvider: await dappConnectorProofProvider(connected, zkConfigProvider, costModel),
    walletProvider: createWalletProvider({
      getCoinPublicKey: () => keys.coinPublicKey,
      getEncryptionPublicKey: () => keys.encryptionPublicKey,
      balanceTx: async (tx) => {
        const balanced = await connected.balanceUnsealedTransaction(toHex(tx));
        return deserializeSealed(balanced.tx);
      },
    }),
    midnightProvider: createMidnightProvider((tx) => submit(connected, tx)),
  };
}
