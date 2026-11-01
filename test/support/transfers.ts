import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";

import { parseShieldedAddress, type ShieldedKeys } from "../../src/address.ts";
import { settledState, syncedState, type Wallet } from "./wallet.ts";

const TX_TTL_MS = 30 * 60 * 1000;

/** The wallet SDK's form of an address. */
export function walletAddress(keys: ShieldedKeys): ShieldedAddress {
  return new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey),
  );
}

/** A private wallet-to-wallet transfer of shielded `color`. This does not touch the contract. */
export async function send(
  wallet: Wallet,
  networkId: string,
  color: string,
  amount: bigint,
  to: string,
): Promise<string> {
  await settledState(wallet);
  const receiverAddress = walletAddress(parseShieldedAddress(to, networkId));
  const outputs = [{ type: color, receiverAddress, amount }];
  const recipe = await wallet.facade.transferTransaction([{ type: "shielded", outputs }], {
    ttl: new Date(Date.now() + TX_TTL_MS),
    payFees: true,
  });
  const signed = await wallet.facade.signRecipe(recipe, (payload) =>
    wallet.keystore.signDataAsync(payload),
  );
  return wallet.facade.submitTransaction(await wallet.facade.finalizeRecipe(signed));
}

export async function shieldedBalance(wallet: Wallet, color: string): Promise<bigint> {
  const state = await syncedState(wallet);
  return state.shielded.balances[color] ?? 0n;
}
