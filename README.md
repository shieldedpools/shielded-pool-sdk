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

`connected` is the wallet's connector API, version 4.1. The SDK re-exports its types, such as `ConnectedAPI` and `InitialAPI`, so you can use the version it's built against without installing the connector package yourself. Amounts are `bigint`s in a token's smallest units. `unshield` takes a recipient from `parseUnshieldedAddress`, `locked` reads what a contract holds, `isImmutable` checks what `maintenanceAuthority` returns, and `wrappedColor` names a wrapped token for the wallet's balances and transfers.

`shield` mints to the connected wallet. To mint to someone else, pass their shielded address (`mn_shield-addr_...`) as `recipient`: `shield(providers, contractAddress, NIGHT, 1_000_000n, { recipient })`. It has to be the whole address, not just their coin key, because the coin is encrypted to the encryption key the address carries, and nothing on chain checks that the two keys belong together. A coin encrypted to the wrong key is valid but its owner's wallet never finds it.

`shield` refuses a contract that isn't known to be immutable, because whoever can change it can take everything it holds. `immutability` gives the answer it goes by: `immutable`, `changeable`, or `unreadable` when the authority can't be read, which `shield` treats as changeable. Pass `allowChangeable: true` only for a contract you control or are testing. `unshield` is never held back, so holders can always leave.

`shield` and `unshield` check their arguments before anything reaches the network: a token is 64 hex characters, an amount runs from 1 to 2⁶⁴ − 1 units, and `unshield`'s recipient is 32 bytes and not the zero address, and `shield`'s is a shielded address on the connected network whose keys aren't zero. `parseUnshieldedAddress` refuses the zero address too.

Both pay people only. The contract can also pay another contract, but minting to one only works if that contract claims the coin in the same transaction, so a lone `shield` can't do it, and the SDK doesn't offer it.

Both take a last, optional `{ onStep, signal }`. `onStep` hears `proving`, `balancing`, `submitting` and `submitted`, with the transaction's id at `submitted`. Aborting `signal` stops the call before the wallet is asked to balance or send it. Once the transaction has been handed over it can't be called back, so aborting changes nothing. Neither call has a timeout of its own: a wallet can hold a request, and the network can take its time, so set your own and abort.

Every failure is a `ShieldedPoolError`. Its `outcome` is `failed` when the transaction is known not to have happened, so trying again can't spend twice. That covers anything before it was handed over, a wallet refusing to send it, and a transaction the network rejected entirely. It's `unknown` when it was handed over and nothing says what became of it, or when the network applied only part of it (`FailFallible`), whose guaranteed part took effect: check balances before you try again. `cause` holds the wallet's own error where there is one, which midnight-js would otherwise have redacted.

Your build needs:

- A `Buffer` global, set before the SDK loads.
- WebAssembly support. With Vite, that's `vite-plugin-wasm` and a `build.target` of `esnext`.
- The `compiler`, `keys` and `zkir` directories from `@shieldedpools/contracts/contract/managed/shielded-pools`, served at the URL you pass to `contractKeys`.

## License

Copyright 2026 The Shielded Pool Authors. Apache-2.0: see [`LICENSE`](LICENSE). Contributions are made under the same license.

The license doesn't cover the Shielded Pool names or logos. Don't imply that your project is official or endorsed, and give a modified version its own name.
