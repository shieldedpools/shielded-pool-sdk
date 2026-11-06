import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";
import * as ledger from "@midnightntwrk/ledger-v9";
import type { Ledger9ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { dappConnectorProofProvider } from "@midnight-ntwrk/midnight-js-dapp-connector-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  type ContractPrivateStates,
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type PrivateStateProvider,
  type ZKConfigProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { hex } from "@scure/base";

import { parseShieldedAddress } from "./address.ts";

// A connected wallet holds the keys, proves, balances and signs. This side never sees a seed or a
// secret key, and only reaches the wallet through the connector API.

const TX_TTL_SECONDS = 30 * 60;

type SealedTransaction = Pick<
  ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>,
  "identifiers" | "serialize"
>;
type SigningKey = Parameters<PrivateStateProvider["setSigningKey"]>[1];

// midnight-js wants a transaction's id, but the connector's submit returns nothing.
function transactionId(tx: SealedTransaction): string {
  const id = tx.identifiers().at(-1);
  if (id === undefined) throw new Error("The wallet returned a transaction with no identifier");
  return id;
}

async function submit(connected: ConnectedAPI, tx: SealedTransaction): Promise<string> {
  const id = transactionId(tx);
  await connected.submitTransaction(hex.encode(tx.serialize()));
  return id;
}

// The contract has no witnesses, so its private state is always empty. midnight-js also makes a
// signing key whenever it attaches, but the contract has no maintenance committee for it to be on,
// so it controls nothing and doesn't need to outlive this object. A connected wallet never deploys.
function emptyPrivateState(): PrivateStateProvider {
  const contracts = new Map<string, Map<string, unknown>>();
  const signingKeys = new Map<string, SigningKey>();
  const unsupported = async (): Promise<never> => {
    throw new Error("A connected wallet has no private state to export or import");
  };
  const forContract = (contractAddress: string): ContractPrivateStates => {
    const states = contracts.get(contractAddress) ?? new Map<string, unknown>();
    contracts.set(contractAddress, states);
    return {
      contractAddress,
      set: async (id, state) => void states.set(id, state),
      get: async (id) => states.get(id) ?? null,
      remove: async (id) => void states.delete(id),
      clear: async () => states.clear(),
      exportPrivateStates: unsupported,
      importPrivateStates: unsupported,
    };
  };
  return {
    forContract,
    clearAll: async () => contracts.clear(),
    setSigningKey: async (address, key) => void signingKeys.set(address, key),
    getSigningKey: async (address) => signingKeys.get(address) ?? null,
    removeSigningKey: async (address) => void signingKeys.delete(address),
    clearSigningKeys: async () => signingKeys.clear(),
    exportSigningKeys: unsupported,
    importSigningKeys: unsupported,
  };
}

/** Providers for `shield`, `unshield` and `attach` that go through a connected wallet. */
export async function connectorProviders(
  connected: ConnectedAPI,
  zkConfigProvider: ZKConfigProvider<string>,
): Promise<Ledger9ContractProviders> {
  const { indexerUri, indexerWsUri, networkId } = await connected.getConfiguration();
  // The connector gives its public keys in Bech32m and midnight-js wants hex.
  const { shieldedAddress } = await connected.getShieldedAddresses();
  const keys = parseShieldedAddress(shieldedAddress, networkId);
  const costModel = ledger.CostModel.initialCostModel();

  return {
    config: { networkId, ttlSeconds: TX_TTL_SECONDS },
    privateStateProvider: emptyPrivateState(),
    publicDataProvider: indexerPublicDataProvider({ queryURL: indexerUri, subscriptionURL: indexerWsUri }),
    zkConfigProvider,
    proofProvider: await dappConnectorProofProvider(connected, zkConfigProvider, costModel),
    // midnight-js checks that the wallet's answer is a balanced ledger 9 transaction.
    walletProvider: createLedger9WalletProvider({
      getCoinPublicKey: () => keys.coinPublicKey,
      getEncryptionPublicKey: () => keys.encryptionPublicKey,
      balanceTx: async (tx) => {
        const balanced = await connected.balanceUnsealedTransaction(hex.encode(tx.serialize()));
        return hex.decode(balanced.tx);
      },
    }),
    midnightProvider: createLedger9MidnightProvider((tx) =>
      submit(connected, tx.deserialize({ v9: ledger.Transaction })),
    ),
  };
}
