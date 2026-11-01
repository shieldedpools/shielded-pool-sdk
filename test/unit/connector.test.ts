import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import type { ConnectedAPI } from "@midnightntwrk/dapp-connector-api";
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from "@midnightntwrk/wallet-sdk-address-format";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";

import { connectorProviders } from "../../src/connector.ts";
import { ZK_DIR } from "../support/config.ts";

describe("connected wallet", () => {
  const networkId = "undeployed";
  const connected = (methods: Partial<ConnectedAPI>) =>
    ({
      getConfiguration: async () => ({
        indexerUri: "http://127.0.0.1:1/graphql",
        indexerWsUri: "ws://127.0.0.1:1/graphql/ws",
        substrateNodeUri: "ws://127.0.0.1:1",
        networkId,
      }),
      ...methods,
    }) as ConnectedAPI;

  it("hands midnight-js the wallet's Bech32m keys as hex", async () => {
    const [coin, encryption] = [randomBytes(32), randomBytes(32)];
    const address = new ShieldedAddress(
      new ShieldedCoinPublicKey(coin),
      new ShieldedEncryptionPublicKey(encryption),
    );
    const shieldedAddress = MidnightBech32m.encode(networkId, address).asString();
    const wallet = connected({
      getShieldedAddresses: async () => ({
        shieldedAddress,
        shieldedCoinPublicKey: "unused",
        shieldedEncryptionPublicKey: "unused",
      }),
      getProvingProvider: async () => ({ check: async () => [], prove: async () => new Uint8Array() }),
    });
    const { walletProvider } = await connectorProviders(wallet, new NodeZkConfigProvider<string>(ZK_DIR));
    assert.equal(walletProvider.getCoinPublicKey(), coin.toString("hex"));
    assert.equal(walletProvider.getEncryptionPublicKey(), encryption.toString("hex"));
  });


});
