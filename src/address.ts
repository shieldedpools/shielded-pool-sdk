import { bech32m, hex } from "@scure/base";

// Midnight addresses are bech32m, prefixed `mn_<type>_<network>`, with no network on mainnet.
// The wallet SDK's parser needs Node's Buffer, and bech32's default limit of 90 characters
// rejects every shielded address.

/** The two keys a shielded address is made of, in hex. */
export interface ShieldedKeys {
  coinPublicKey: string;
  encryptionPublicKey: string;
}

function decode(text: string, type: string, networkId: string, length: number): Uint8Array {
  const { prefix, bytes } = bech32m.decodeToBytes(text as `${string}1${string}`, false);
  const expected = networkId === "mainnet" ? `mn_${type}` : `mn_${type}_${networkId}`;
  if (prefix !== expected || bytes.length !== length) {
    throw new Error(`Not a ${type} address on ${networkId}: ${text}`);
  }
  return bytes;
}

export function parseShieldedAddress(text: string, networkId: string): ShieldedKeys {
  const bytes = decode(text, "shield-addr", networkId, 64);
  return {
    coinPublicKey: hex.encode(bytes.subarray(0, 32)),
    encryptionPublicKey: hex.encode(bytes.subarray(32)),
  };
}

/** The 32 bytes a contract sees as this address's `UserAddress`. */
export function parseUnshieldedAddress(text: string, networkId: string): Uint8Array {
  return decode(text, "addr", networkId, 32);
}
