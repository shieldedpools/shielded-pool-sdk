// Deploys the contract for the end-to-end tests. Real deployments come from the contracts
// repository's deploy script. This gives the contract the same empty maintenance authority, so
// the tests run against what ships.
import {
  type ContractProviders,
  createUnprovenDeployTx,
  submitTx,
} from "@midnight-ntwrk/midnight-js-contracts";
import { SucceedEntirely } from "@midnight-ntwrk/midnight-js-types";
import * as ledger from "@midnightntwrk/ledger-v9";

import { compiled } from "../../src/pool.ts";

const TX_TTL_MS = 30 * 60 * 1000;

export async function deploy(providers: ContractProviders): Promise<string> {
  const { public: { initialContractState } } = await createUnprovenDeployTx(providers, {
    compiledContract: compiled,
    initialPrivateState: {},
    args: [],
    // midnight-js has to put a key on the authority, which is replaced below before anything is sent.
    signingKey: ledger.sampleSigningKey(),
  });
  const state = ledger.ContractState.deserialize(initialContractState.serialize());
  state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority([], 1, 0n);
  const deployment = new ledger.ContractDeploy(state);
  const intent = ledger.Intent.new(new Date(Date.now() + TX_TTL_MS)).addDeploy(deployment);
  const { networkId } = providers.config;
  const tx = ledger.Transaction.fromParts(networkId, undefined, undefined, intent);
  const { status } = await submitTx(providers, { unprovenTx: { version: "v9", tx } });
  if (status !== SucceedEntirely) throw new Error(`Deploying the contract ended with ${status}`);
  return deployment.address;
}
