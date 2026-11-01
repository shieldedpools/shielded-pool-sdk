// Runs in Chromium, against the built SDK. Everything here is what an application would do.
import { bech32m } from "@scure/base";
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;

const failure = (run) =>
  run().then(
    () => "accepted",
    (error) => String(error?.message ?? error).slice(0, 200),
  );

const out = document.getElementById("out");
try {
  const sdk = await import("@shieldedpools/sdk");
  const keys = sdk.contractKeys(new URL("/zk/", location.href).href);
  const tampered = sdk.contractKeys(new URL("/zk-tampered/", location.href).href);

  const address = bech32m.encode("mn_shield-addr_undeployed", bech32m.toWords(new Uint8Array(64)), false);
  const connected = {
    getConfiguration: async () => ({
      indexerUri: "http://127.0.0.1:1/graphql",
      indexerWsUri: "ws://127.0.0.1:1/graphql/ws",
      substrateNodeUri: "ws://127.0.0.1:1",
      networkId: "undeployed",
    }),
    getShieldedAddresses: async () => ({
      shieldedAddress: address,
      shieldedCoinPublicKey: "unused",
      shieldedEncryptionPublicKey: "unused",
    }),
    getProvingProvider: async () => ({ check: async () => [], prove: async () => new Uint8Array() }),
  };
  const providers = await sdk.connectorProviders(connected, keys);

  out.textContent = JSON.stringify({
    color: sdk.wrappedColor("ab".repeat(32), sdk.NIGHT),
    coinKey: providers.walletProvider.getCoinPublicKey(),
    proverKeyBytes: (await keys.getProverKey("shield")).length,
    verifierKeyBytes: (await keys.getVerifierKey("unshield")).length,
    zkirBytes: (await keys.getZKIR("shield")).length,
    tampered: await failure(() => tampered.getVerifierKey("shield")),
  });
} catch (error) {
  out.textContent = JSON.stringify({ error: String(error?.stack ?? error) });
}
