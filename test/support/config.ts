import { createRequire } from "node:module";
import * as path from "node:path";

/** The contract's compiled keys and ZKIR, two levels up from its `compiler/contract-info.json`. */
export const ZK_DIR = path.resolve(
  createRequire(import.meta.url).resolve("@shieldedpools/contracts/contract-info.json"),
  "../..",
);

export interface Network {
  id: string;
  node: string;
  indexerHttp: string;
  indexerWs: string;
  proofServer: string;
}

/** The local network in compose.yml, the only one these tests run against. */
export const network: Network = {
  id: "undeployed",
  node: "http://127.0.0.1:9944",
  indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  proofServer: "http://127.0.0.1:6300",
};
