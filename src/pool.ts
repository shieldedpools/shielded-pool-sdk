import { CompiledContract, type Contract as CompactContract } from "@midnight-ntwrk/compact-js";
import {
  findDeployedContract,
  getUnshieldedBalances,
  type Ledger9ContractProviders,
} from "@midnight-ntwrk/midnight-js-contracts";
import {
  ContractState,
  createShieldedCoinInfo,
  encodeShieldedCoinInfo,
  nativeToken,
  rawTokenType,
} from "@midnightntwrk/ledger-v9";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import type { ZKConfigProvider } from "@midnight-ntwrk/midnight-js-types";
import { type Circuits, Contract } from "@shieldedpools/contracts";
import { hex } from "@scure/base";

import { type CallOptions, ShieldedPoolError, track } from "./transaction.ts";

/** NIGHT's colour. Tokens are identified by colour, as 64 hex characters. */
export const NIGHT = nativeToken().raw;

// The generated class and the SDK's contract type disagree on circuit shapes, so
// the SDK's generics are bound to Contract.Any here and nowhere else. Proofs get their keys from
// the providers: nothing reads the assets path, but the type requires one.
export const compiled = CompiledContract.withCompiledFileAssets(
  CompiledContract.withVacantWitnesses(
    CompiledContract.make("shielded-pools", Contract as unknown as new () => CompactContract.Any),
  ),
  "shielded-pools",
);

export const PRIVATE_STATE_ID = "shielded-pool";

// SHA-256 of the contract's compiler/contract-manifest.json, which lists every key and ZKIR file
// by hash. Pinning it here means whoever serves those files can't swap them, even with a matching
// manifest. A unit test fails if this drifts from the contracts package this SDK is locked to.
const CONTRACT_MANIFEST_SHA256 = "abf9a282ba1258781fbe4beaecc9495a205b453b49f31ec90d055299863f883e";

/**
 * Keys and ZKIR for `connectorProviders`, fetched from `baseUrl`, an absolute URL. It has to serve
 * the contract's `compiler`, `keys` and `zkir` directories, and is checked against this release.
 */
export function contractKeys(baseUrl: string): ZKConfigProvider<string> {
  return new FetchZkConfigProvider<string>(baseUrl, {
    expectedManifestHash: CONTRACT_MANIFEST_SHA256,
    fetchFunc: globalThis.fetch.bind(globalThis),
  });
}

/**
 * The two circuits, narrowed from the SDK's Contract.Any view. Their arguments come from the
 * generated types, so a change to a circuit's signature fails to compile here.
 */
interface WrapperCircuits {
  shield(...args: CircuitArgs<"shield">): Promise<CallResult>;
  unshield(...args: CircuitArgs<"unshield">): Promise<CallResult>;
}
type CircuitArgs<K extends keyof Circuits<unknown>> =
  Parameters<Circuits<unknown>[K]> extends [unknown, ...infer Args] ? Args : never;
type CallResult = { public: { txId: string } };

// The contract takes amounts as a `Uint<64>`.
const MAX_AMOUNT = 2n ** 64n - 1n;

const refuse = (message: string): never => {
  throw new ShieldedPoolError(message, "failed");
};

// These run before anything reaches the network, so a mistake costs nothing and the reason is clear.
function checkToken(token: string): void {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)) {
    refuse("A token is its colour, as 64 hex characters");
  }
}

function checkAmount(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 1n || amount > MAX_AMOUNT) {
    refuse(`The amount has to be a bigint from 1 to ${MAX_AMOUNT} units`);
  }
}

function checkRecipient(recipient: Uint8Array): void {
  if (!(recipient instanceof Uint8Array) || recipient.length !== 32) {
    refuse("The recipient has to be 32 bytes, as parseUnshieldedAddress returns");
  }
  // The contract refuses it too, but only once it's been asked.
  if (recipient.every((byte) => byte === 0)) refuse("The zero address can't receive tokens");
}

/** The colour of `token`'s wrapped token. It must match `tokenType()` in the contract. */
export function wrappedColor(contractAddress: string, token: string): string {
  return rawTokenType(hex.decode(token), contractAddress);
}

export async function attach(
  providers: Ledger9ContractProviders,
  contractAddress: string,
): Promise<WrapperCircuits> {
  const found = await findDeployedContract(providers, {
    compiledContract: compiled,
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
  return found.callTx as unknown as WrapperCircuits;
}

/**
 * Locks `amount` units of `token` and mints the same amount of its wrapped token to this wallet.
 * Resolves to the transaction's id once the network has confirmed it.
 *
 * Throws {@link ShieldedPoolError}. Its `outcome` says whether the transaction might have been sent:
 * arguments the contract can't take, for one, are refused as `failed` before anything is sent.
 */
export async function shield(
  providers: Ledger9ContractProviders,
  contractAddress: string,
  token: string,
  amount: bigint,
  options: CallOptions = {},
): Promise<string> {
  checkToken(token);
  checkAmount(amount);
  return track(providers, options, async (observed) => {
    const contract = await attach(observed, contractAddress);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const result = await contract.shield(hex.decode(token), amount, nonce);
    return result.public.txId;
  });
}

/**
 * Pays `amount` units of `token`'s wrapped token into the contract, where they are retired,
 * and releases the same amount of `token` to `recipient`.
 *
 * The coin is fresh: the wallet funds it from whatever wrapped coins it holds and
 * keeps the change, so the amount does not have to match an earlier `shield`.
 *
 * Throws {@link ShieldedPoolError}, as `shield` does. The zero address as `recipient` is refused
 * as `failed` before anything is sent.
 */
export async function unshield(
  providers: Ledger9ContractProviders,
  contractAddress: string,
  token: string,
  amount: bigint,
  recipient: Uint8Array,
  options: CallOptions = {},
): Promise<string> {
  checkToken(token);
  checkAmount(amount);
  checkRecipient(recipient);
  return track(providers, options, async (observed) => {
    const contract = await attach(observed, contractAddress);
    const color = wrappedColor(contractAddress, token);
    const coin = encodeShieldedCoinInfo(createShieldedCoinInfo(color, amount));
    const result = await contract.unshield(hex.decode(token), coin, { bytes: recipient });
    return result.public.txId;
  });
}

export interface Authority {
  committee: string[];
  threshold: number;
  counter: bigint;
}

/** Who can replace this contract's circuits, and with them take everything it holds. */
export async function maintenanceAuthority(
  providers: Ledger9ContractProviders,
  contractAddress: string,
): Promise<Authority> {
  const read = await providers.publicDataProvider.queryContractState(contractAddress);
  if (read?.contractState.era !== "v9") throw new Error(`No ledger 9 contract at ${contractAddress}`);
  const state = read.contractState.deserialize({ v9: ContractState });
  const { committee, threshold, counter } = state.maintenanceAuthority;
  return { committee: committee.map((key) => key.value), threshold, counter };
}

/**
 * Whether nobody can ever change this contract. An update needs `threshold` signatures from
 * different committee positions, so a threshold above the committee's size can't be met. An empty
 * committee isn't enough: the ledger accepts a threshold of 0, and then anyone can change the
 * contract without signing.
 */
export function isImmutable({ committee, threshold }: Authority): boolean {
  return threshold > committee.length;
}

/** The `token` backing its wrapped token, read from the contract's public balance. */
export async function locked(
  providers: Ledger9ContractProviders,
  contractAddress: string,
  token: string,
): Promise<bigint> {
  const held = await getUnshieldedBalances(providers.publicDataProvider, contractAddress);
  return held.find(({ tokenType }) => tokenType === token)?.balance ?? 0n;
}
