// Needs the local network: npm run network:up
// npm run test:live:connector sends the same calls through a connected wallet.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CompiledContract, type Contract as CompactContract } from "@midnight-ntwrk/compact-js";
import { deployContract, type Ledger9ContractProviders, submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { LedgerTransaction, SucceedEntirely } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";
import { WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { DefaultForkSchedule } from "@midnightntwrk/wallet-sdk-facade";

import { network, ZK_DIR } from "../support/config.ts";
import { deploy } from "../support/deploy.ts";
import { createProviders } from "../support/providers.ts";
import { send, shieldedBalance } from "../support/transfers.ts";
import {
  openWallet,
  settledState,
  syncedState,
  unwrapFinalized,
  userAddressBytes,
  type Wallet,
} from "../support/wallet.ts";
import { connectorProviders } from "../../src/connector.ts";
import {
  attach,
  compiled,
  isImmutable,
  locked,
  maintenanceAuthority,
  NIGHT,
  PRIVATE_STATE_ID,
  shield,
  unshield,
  unshieldToPerson,
  wrappedColor,
} from "../../src/pool.ts";
import { fakeConnector } from "./fake-connector.ts";

const VIA_CONNECTOR = process.env.E2E_CONNECTOR === "1";
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-pool-test-"));
const MINTER_DIR = path.resolve(import.meta.dirname, "managed/minter");

interface Actor {
  wallet: Wallet;
  /** What a user acts through. */
  providers: Ledger9ContractProviders;
  /** A connected wallet never deploys, so this is always the Node path. */
  deployer: Ledger9ContractProviders;
  shielded: string;
}

function userProviders(wallet: Wallet, dir: string): Promise<Ledger9ContractProviders> {
  if (!VIA_CONNECTOR) return createProviders(wallet, network, ZK_DIR, dir);
  const zkConfig = new NodeZkConfigProvider<string>(ZK_DIR);
  return connectorProviders(fakeConnector(wallet, network), zkConfig);
}

// A connected wallet makes transfers itself, so the SDK isn't involved.
async function transfer(wallet: Wallet, color: string, amount: bigint, to: string) {
  if (!VIA_CONNECTOR) return send(wallet, network.id, color, amount, to);
  const connector = fakeConnector(wallet, network);
  const output = { kind: "shielded" as const, type: color, value: amount, recipient: to };
  const { tx } = await connector.makeTransfer([output]);
  return connector.submitTransaction(tx);
}

async function actor(seed: string): Promise<Actor> {
  const wallet = await openWallet(network, seed.padStart(64, "0"));
  const dir = path.join(stateRoot, seed);
  const deployer = await createProviders(wallet, network, ZK_DIR, dir);
  const providers = VIA_CONNECTOR ? await userProviders(wallet, dir) : deployer;
  const state = await syncedState(wallet);
  const shielded = MidnightBech32m.encode(network.id, state.shielded.address).asString();
  return { wallet, providers, deployer, shielded };
}

// Stands in for another token's issuer.
async function mintToken(wallet: Wallet, amount: bigint): Promise<string> {
  const providers = await createProviders(wallet, network, MINTER_DIR, path.join(stateRoot, "m"));
  const { Contract } = await import(path.join(MINTER_DIR, "contract/index.js"));
  const compiledContract = CompiledContract.withCompiledFileAssets(
    CompiledContract.withVacantWitnesses(
      CompiledContract.make("minter", Contract as new () => CompactContract.Any),
    ),
    MINTER_DIR,
  );
  const options = { compiledContract, privateStateId: "m", initialPrivateState: {}, args: [] };
  const deployed = (await deployContract(providers, options as never)) as unknown as {
    callTx: { mint(...args: unknown[]): Promise<{ private: { result: Uint8Array } }> };
  };
  const domain = Buffer.alloc(32);
  domain.write("usd");
  const minted = await deployed.callTx.mint(domain, amount, { bytes: userAddressBytes(wallet) });
  return Buffer.from(minted.private.result).toString("hex");
}

async function eventually(read: () => Promise<bigint>, expected: bigint, label: string) {
  const deadline = Date.now() + 120_000;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await delay(1_000);
    value = await read();
  }
  assert.equal(value, expected, label);
}

// The SDK nests the reason, and redacts some of it, so collect the whole chain.
function reason(error: unknown): string {
  const messages: string[] = [];
  for (let e = error as { message?: string; cause?: unknown }; e; e = e.cause as typeof e) {
    messages.push(String(e.message ?? e));
  }
  return messages.join(" <- ");
}

async function rejected(attempt: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(attempt, (error) => {
    assert.match(reason(error), pattern);
    return true;
  });
}

// A transaction's commitments take consecutive positions in the tree, in the order of its outputs.
async function contractCoinIndex(txId: string): Promise<bigint> {
  const query = `{transactions(offset:{identifier:"${txId}"}){
    ... on RegularTransaction{raw zswapStartIndex}}}`;
  for (let i = 0; i < 30; i++) {
    const response = await fetch(network.indexerHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const { data } = (await response.json()) as {
      data?: { transactions?: { raw: string; zswapStartIndex: number }[] };
    };
    const found = data?.transactions?.[0];
    if (found !== undefined) {
      const raw = Buffer.from(found.raw, "hex");
      const tx = ledger.Transaction.deserialize("signature", "proof", "binding", raw);
      const position = tx.guaranteedOffer!.outputs.findIndex((output) => output.contractAddress);
      assert.notEqual(position, -1);
      return BigInt(found.zswapStartIndex) + BigInt(position);
    }
    await delay(1_000);
  }
  throw new Error(`The indexer never saw ${txId}`);
}

describe("Shielded pool on a local chain", { concurrency: false }, () => {
  let alice: Actor;
  let bob: Actor;
  let contract: string;
  let usd: string;
  const backing = new Map<string, bigint>();

  const color = (token: string) => wrappedColor(contract, token);
  const inCirculation = async (token: string) => {
    let total = 0n;
    for (const { wallet } of [alice, bob]) {
      total += await shieldedBalance(wallet, color(token));
    }
    return total;
  };
  const assertBacked = async () => {
    for (const [token, amount] of backing) {
      await eventually(() => locked(alice.providers, contract, token), amount, `locked ${token}`);
      await eventually(() => inCirculation(token), amount, `wrapped ${token}`);
    }
  };

  before(async () => {
    alice = await actor("1");
    bob = await actor("2");
    contract = await deploy(alice.deployer);
    usd = await mintToken(alice.wallet, 1_000_000n);
    await settledState(alice.wallet);
    backing.set(NIGHT, 0n);
    backing.set(usd, 0n);
  });

  it("keeps each token exactly backed through a random order of calls", async () => {
    const steps: string[] = [];
    const onStep = (step: string, id?: string) => steps.push(id === undefined ? step : `${step} ${id}`);
    const txId = await shield(alice.providers, contract, NIGHT, 100_000_000n, { onStep });
    assert.deepEqual(steps, ["proving", "balancing", "submitting", `submitted ${txId}`]);
    backing.set(NIGHT, 100_000_000n);
    await assertBacked();
    for (let step = 0; step < 6; step++) {
      const token = randomBytes(1)[0]! % 2 === 0 ? NIGHT : usd;
      const held = backing.get(token)!;
      const amount = BigInt(1 + randomBytes(2).readUInt16LE());
      if (held >= amount && randomBytes(1)[0]! % 2 === 0) {
        const to = userAddressBytes(alice.wallet);
        await unshield(alice.providers, contract, token, amount, to);
        backing.set(token, held - amount);
      } else {
        await shield(alice.providers, contract, token, amount);
        backing.set(token, held + amount);
      }
      await assertBacked();
    }
  });

  // Nothing here waits between calls: each one has to wait for the last to settle by itself.
  it("runs consecutive transactions from one wallet without reusing a coin", async () => {
    await deploy(alice.deployer);
    await deploy(alice.deployer);
    await shield(alice.providers, contract, NIGHT, 5_000_000n);
    await shield(alice.providers, contract, NIGHT, 5_000_000n);
    const to = userAddressBytes(alice.wallet);
    await unshield(alice.providers, contract, NIGHT, 1_000_000n, to);
    await unshield(alice.providers, contract, NIGHT, 1_000_000n, to);
    await transfer(alice.wallet, color(NIGHT), 1_000_000n, alice.shielded);
    await transfer(alice.wallet, color(NIGHT), 1_000_000n, alice.shielded);
    backing.set(NIGHT, backing.get(NIGHT)! + 8_000_000n);
    await assertBacked();
  });

  it("refuses to pay out one token against another's wrapped coin", async () => {
    const circuits = await attach(alice.providers, contract);
    const coin = (token: string) =>
      ledger.encodeShieldedCoinInfo(ledger.createShieldedCoinInfo(color(token), 1_000n));
    const me = unshieldToPerson(userAddressBytes(alice.wallet));
    const token = (hex: string) => Buffer.from(hex, "hex");
    await rejected(circuits.unshield(token(NIGHT), coin(usd), me), /wrong token/);
    await rejected(circuits.unshield(token(usd), coin(NIGHT), me), /wrong token/);
    await rejected(
      circuits.unshield(token(NIGHT), coin(NIGHT), unshieldToPerson(Buffer.alloc(32))),
      /zero recipient/,
    );
    await assertBacked();
  });

  it("never lets a retired coin move again", async () => {
    const circuits = await attach(alice.providers, contract);
    const amount = 5_000_000n;
    const coin = ledger.createShieldedCoinInfo(color(NIGHT), amount);
    const encoded = ledger.encodeShieldedCoinInfo(coin);
    const token = Buffer.from(NIGHT, "hex");
    const me = unshieldToPerson(userAddressBytes(alice.wallet));

    const { public: { txId } } = await circuits.unshield(token, encoded, me);
    backing.set(NIGHT, backing.get(NIGHT)! - amount);
    await assertBacked();
    await settledState(alice.wallet);

    // The same coin again, so it would withdraw twice for one retirement.
    await rejected(circuits.unshield(token, encoded, me), /submitTx rejected/);
    await settledState(alice.wallet);

    // Claiming the coin straight out of the contract, with a valid proof.
    const index = await contractCoinIndex(txId);
    const { wallet, providers } = alice;
    // The indexer's tree is sparse, so asking it for the coin is the only way to know it's there.
    const inputForCoin = async () => {
      for (let i = 0; i < 60; i++) {
        const states = await providers.publicDataProvider.queryZSwapAndContractState(contract);
        const zswapChainState = states!.zswapChainState.deserialize({ v9: ledger.ZswapChainState });
        try {
          const qualified = { ...coin, mt_index: index };
          return ledger.ZswapInput.newContractOwned(qualified, 0, contract, zswapChainState);
        } catch (error) {
          if (!/invalid index/.test(reason(error))) throw error;
        }
        await delay(1_000);
      }
      throw new Error(`The commitment tree never held ${index}`);
    };
    const spend = async () => {
      const input = await inputForCoin();
      const output = ledger.ZswapOutput.new(
        ledger.createShieldedCoinInfo(color(NIGHT), amount),
        0,
        wallet.keys.coinPublicKey,
        wallet.keys.encryptionPublicKey,
      );
      const offer = ledger.ZswapOffer.fromInput(input, color(NIGHT), amount).merge(
        ledger.ZswapOffer.fromOutput(output, color(NIGHT), amount),
      );
      const v9 = DefaultForkSchedule.v9;
      const parts = ledger.Transaction.fromParts(network.id, offer);
      const proven = await wallet.facade.finalizeTransaction(WalletTransaction.adopt("Unproven", parts, v9));
      const recipe = await wallet.facade.balanceFinalizedTransaction(
        WalletTransaction.adopt("Finalized", unwrapFinalized(proven), v9),
        { ttl: new Date(Date.now() + 1_800_000), tokenKindsToBalance: ["dust"] },
      );
      const signed = await wallet.facade.signRecipe(recipe, (payload) =>
        wallet.keystore.signDataAsync(payload),
      );
      return wallet.facade.submitTransaction(await wallet.facade.finalizeRecipe(signed));
    };
    // Proving succeeds, so this is the ledger refusing the spend, not a client-side failure.
    await rejected(spend(), /submission error/i);
    await delay(9_000);
    await assertBacked();
  });

  it("can't be changed by anyone", async () => {
    const authority = await maintenanceAuthority(alice.providers, contract);
    assert.deepEqual(authority, { committee: [], threshold: 1, counter: 0n });
    assert.ok(isImmutable(authority));

    // Compact 0.36.0 keys are stored as operation version v4. Removing a version the contract
    // doesn't have fails even when signed, which would make the control below meaningless.
    const removeUnshield = (address: string, key?: ledger.SigningKey) => {
      const remove = new ledger.VerifierKeyRemove("unshield", new ledger.ContractOperationVersion("v4"));
      const unsigned = new ledger.MaintenanceUpdate(address, [remove], 0n);
      const update = key
        ? unsigned.addSignature(0n, ledger.signData(key, unsigned.dataToSign))
        : unsigned;
      const intent = ledger.Intent.new(new Date(Date.now() + 120_000)).addMaintenanceUpdate(update);
      const tx = ledger.Transaction.fromParts(network.id, undefined, undefined, intent);
      return submitTx(alice.deployer, { unprovenTx: LedgerTransaction.seal("v9", "Unproven", tx) });
    };
    await rejected(removeUnshield(contract), /submit/i);
    await rejected(removeUnshield(contract, ledger.sampleSigningKey()), /submit/i);

    // The error hides the ledger's reason, so show the update itself is sound: it goes through on a
    // contract with a key that can sign, which is the only difference.
    const signingKey = ledger.sampleSigningKey();
    const options = {
      compiledContract: compiled,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
      args: [],
      signingKey,
    };
    const controlled = await deployContract(alice.deployer, options as never);
    const { contractAddress } = controlled.deployTxData.public;
    // Its key can take whatever it holds, so the SDK won't shield into it.
    await rejected(
      shield(alice.providers, contractAddress, NIGHT, 1n),
      /Refusing to shield into this contract, because 1 of its 1 maintainers can change it/,
    );
    const { status } = await removeUnshield(contractAddress, signingKey);
    assert.equal(status, SucceedEntirely);
  });

  it("moves wrapped tokens privately between wallets", async () => {
    await transfer(alice.wallet, color(NIGHT), 2_000_000n, bob.shielded);
    await eventually(() => shieldedBalance(bob.wallet, color(NIGHT)), 2_000_000n, "Bob paid");
    await assertBacked();
  });
});
