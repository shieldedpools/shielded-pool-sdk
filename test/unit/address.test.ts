import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  mainnet,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from "@midnightntwrk/wallet-sdk-address-format";

import { parseShieldedAddress, parseUnshieldedAddress } from "../../src/address.ts";

describe("addresses", () => {
  const keys = () => [randomBytes(32), randomBytes(32)] as const;
  const shieldedAddress = (coin: Buffer, encryption: Buffer, networkId: string) =>
    MidnightBech32m.encode(
      networkId,
      new ShieldedAddress(new ShieldedCoinPublicKey(coin), new ShieldedEncryptionPublicKey(encryption)),
    ).asString();

  it("reads what the wallet SDK writes, on any network", () => {
    for (const networkId of ["undeployed", "preview", "mainnet"]) {
      const encoding = networkId === "mainnet" ? mainnet : networkId;
      const [coin, encryption] = keys();
      const address = shieldedAddress(coin, encryption, encoding as string);
      assert.deepEqual(parseShieldedAddress(address, networkId), {
        coinPublicKey: coin.toString("hex"),
        encryptionPublicKey: encryption.toString("hex"),
      });
      const text = MidnightBech32m.encode(encoding as string, new UnshieldedAddress(coin)).asString();
      assert.deepEqual(Buffer.from(parseUnshieldedAddress(text, networkId)), coin);
    }
  });

  it("refuses another network's address", () => {
    const [coin, encryption] = keys();
    const address = shieldedAddress(coin, encryption, "preview");
    assert.throws(() => parseShieldedAddress(address, "undeployed"), /Not a shield-addr address/);
  });

  it("refuses the wrong kind of address, and anything corrupted", () => {
    const [coin, encryption] = keys();
    const unshielded = MidnightBech32m.encode("undeployed", new UnshieldedAddress(coin)).asString();
    assert.throws(() => parseShieldedAddress(unshielded, "undeployed"), /Not a shield-addr address/);
    const shielded = shieldedAddress(coin, encryption, "undeployed");
    assert.throws(() => parseUnshieldedAddress(shielded, "undeployed"), /Not a addr address/);
    const last = shielded.at(-1) === "q" ? "p" : "q";
    assert.throws(() => parseShieldedAddress(shielded.slice(0, -1) + last, "undeployed"));
  });
});
