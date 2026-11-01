# Shielded Pool SDK

A browser SDK for Shielded Pool, a 1:1 shielded wrapper for Midnight's unshielded tokens. A connected wallet owns keys, proving, balancing and submission. This SDK builds the contract calls and hands them to the wallet.

## Usage

```sh
npm install @shieldedpools/sdk
```

```ts
import { connectorProviders, contractKeys, NIGHT, shield } from "@shieldedpools/sdk";

const keys = contractKeys(new URL("/zk/", location.href).href);
const providers = await connectorProviders(connected, keys);

const txId = await shield(providers, contractAddress, NIGHT, 1_000_000n);
```

`connected` is the wallet's connector API, version 4.1. Amounts are `bigint`s in a token's smallest units. `unshield` takes a recipient from `parseUnshieldedAddress`, `locked` reads what a contract holds, `isImmutable` checks what `maintenanceAuthority` returns, and `wrappedColor` names a wrapped token for the wallet's balances and transfers.

Your build needs:

- A `Buffer` global, set before the SDK loads.
- WebAssembly support. With Vite, that's `vite-plugin-wasm` and a `build.target` of `esnext`.
- The `compiler`, `keys` and `zkir` directories from `@shieldedpools/contracts/contract/managed/shielded-pools`, served at the URL you pass to `contractKeys`.

## License

Copyright 2026 The Shielded Pool Authors. Apache-2.0: see [`LICENSE`](LICENSE). Contributions are made under the same license.

The license doesn't cover the Shielded Pool names or logos. Don't imply that your project is official or endorsed, and give a modified version its own name.
