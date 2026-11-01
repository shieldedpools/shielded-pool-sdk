import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as Rx from "rxjs";

import { settledState, type Wallet } from "../support/wallet.ts";

describe("settled wallet state", () => {
  const snapshot = (isSynced: boolean, shielded: number, unshielded: number, dust: number) => ({
    isSynced,
    shielded: { pendingCoins: Array(shielded) },
    unshielded: { pendingCoins: Array(unshielded) },
    dust: { pendingCoins: Array(dust) },
  });
  const walletOver = (states: Rx.Observable<unknown>) =>
    ({ facade: { state: () => states } }) as unknown as Pick<Wallet, "facade">;

  it("waits until every spend is back and the wallet has caught up", async () => {
    const states = new Rx.Subject<ReturnType<typeof snapshot>>();
    let settled = false;
    const waiting = settledState(walletOver(states)).then(() => {
      settled = true;
    });
    for (const state of [
      snapshot(true, 0, 0, 1),
      snapshot(true, 1, 0, 0),
      snapshot(true, 0, 1, 0),
      snapshot(false, 0, 0, 0),
    ]) {
      states.next(state);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
    }
    states.next(snapshot(true, 0, 0, 0));
    await waiting;
  });

  it("is immediate for a wallet with nothing pending", async () => {
    await settledState(walletOver(Rx.of(snapshot(true, 0, 0, 0))));
  });
});
