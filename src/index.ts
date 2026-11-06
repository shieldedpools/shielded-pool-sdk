// The published SDK. A connected wallet owns keys, proving, balancing and submission, so nothing
// here may need Node, a seed or a filesystem.
export { parseUnshieldedAddress } from "./address.ts";
export { connectorProviders } from "./connector.ts";
export {
  type Authority,
  contractKeys,
  isImmutable,
  locked,
  maintenanceAuthority,
  NIGHT,
  shield,
  unshield,
  wrappedColor,
} from "./pool.ts";
export { type CallOptions, type Outcome, ShieldedPoolError, type Step } from "./transaction.ts";
// The connector API this SDK is built against, so an app that talks to the wallet uses the same
// version that `connectorProviders` expects.
export type {
  APIError,
  Configuration,
  ConnectedAPI,
  ErrorCode,
  InitialAPI,
  WalletConnectedAPI,
} from "@midnightntwrk/dapp-connector-api";
