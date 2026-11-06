import { type Ledger9ContractProviders, TxFailedError } from "@midnight-ntwrk/midnight-js-contracts";
import { FailEntirely } from "@midnight-ntwrk/midnight-js-types";

// midnight-js hides a transaction's steps, and redacts a provider's own error before it rethrows.
// So a call watches its providers: that's how it reports each step, keeps the wallet's error, and
// knows whether the transaction was ever handed over to be sent.

/** Where a transaction has got to. `submitted` means the wallet said it sent it. */
export type Step = "proving" | "balancing" | "submitting" | "submitted";

/**
 * `failed`: it's known not to have happened, so trying again can't spend twice. `unknown`: it was
 * handed over to be sent and nothing says what became of it, so check balances before trying again.
 */
export type Outcome = "failed" | "unknown";

export interface CallOptions {
  /** Called at each step, with the transaction's id once it's submitted. An exception from it is ignored. */
  onStep?: (step: Step, txId?: string) => void;
  /**
   * Stops the call before the wallet is asked to balance or submit. A transaction that's already
   * been handed over can't be called back, so aborting after that changes nothing.
   */
  signal?: AbortSignal;
}

/** Why a `shield` or `unshield` didn't go through. */
export class ShieldedPoolError extends Error {
  override readonly name = "ShieldedPoolError";
  readonly outcome: Outcome;

  constructor(message: string, outcome: Outcome, options?: ErrorOptions) {
    super(message, options);
    this.outcome = outcome;
  }
}

// The connector API says to check `type`, because `instanceof` can't work across a wallet's bundle.
function connectorCode(error: unknown): string | undefined {
  const candidate = error as { type?: unknown; code?: unknown } | null | undefined;
  return candidate?.type === "DAppConnectorAPIError" && typeof candidate.code === "string"
    ? candidate.code
    : undefined;
}

// What a wallet says when it declined to send, as opposed to losing track of the request.
const REFUSALS = new Set(["Rejected", "PermissionRejected", "InvalidRequest"]);

interface Progress {
  /** The wallet was asked to submit it, so from here on it may be on its way. */
  handedOver: boolean;
  /** The wallet said it had submitted it. */
  accepted: boolean;
  /** The first error a provider threw, before midnight-js redacted it. */
  providerError?: unknown;
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";

/** The error a failed call throws, worked out from how far it got. */
function classify(error: unknown, progress: Progress): ShieldedPoolError {
  if (error instanceof ShieldedPoolError) return error;
  if (error instanceof TxFailedError) {
    // Only a transaction the network rejected entirely left nothing behind. One whose fallible part
    // failed kept the effects of its guaranteed part, so some of it did happen.
    const { status } = error.record;
    return status === FailEntirely
      ? new ShieldedPoolError(`The network rejected the transaction (${status})`, "failed", { cause: error })
      : new ShieldedPoolError(
          `The network applied only part of the transaction (${status}), so check balances before trying again`,
          "unknown",
          { cause: error },
        );
  }
  const cause = progress.providerError ?? error;
  // An abort is thrown from inside a provider, so midnight-js has wrapped it on the way out.
  if (cause instanceof ShieldedPoolError) return cause;
  if (!progress.handedOver) {
    return new ShieldedPoolError(`The transaction failed before it was sent: ${firstLine(cause)}`, "failed", {
      cause,
    });
  }
  const code = connectorCode(cause);
  if (!progress.accepted && code !== undefined && REFUSALS.has(code)) {
    return new ShieldedPoolError(`The wallet refused to send the transaction: ${firstLine(cause)}`, "failed", {
      cause,
    });
  }
  return new ShieldedPoolError(
    `It isn't known whether the transaction went through: ${firstLine(cause)}`,
    "unknown",
    { cause },
  );
}

type Method = (...args: never[]) => Promise<unknown>;

// `Object.create` keeps everything else the provider has, `supportedEras` included, even when it's
// a class instance, which a spread wouldn't.
function around<K extends string, T extends Record<K, Method>>(
  target: T,
  method: K,
  wrap: (call: () => Promise<unknown>) => Promise<unknown>,
): T {
  const wrapped = (...args: never[]) => wrap(() => Reflect.apply(target[method], target, args));
  return Object.assign(Object.create(target) as T, { [method]: wrapped });
}

function observe(
  providers: Ledger9ContractProviders,
  { onStep, signal }: CallOptions,
  progress: Progress,
): Ledger9ContractProviders {
  const report = (step: Step, txId?: string) => {
    try {
      onStep?.(step, txId);
    } catch {
      // A caller's callback can't change what happens to the transaction.
    }
  };
  const stopIfAborted = (before: string) => {
    if (signal?.aborted) {
      throw new ShieldedPoolError(`Stopped before ${before}`, "failed", { cause: signal.reason });
    }
  };
  const noting = async (call: () => Promise<unknown>) => {
    try {
      return await call();
    } catch (error) {
      progress.providerError ??= error;
      throw error;
    }
  };

  return {
    ...providers,
    proofProvider: around(providers.proofProvider, "proveTx", (call) => {
      report("proving");
      return noting(call);
    }),
    walletProvider: around(providers.walletProvider, "balanceTx", (call) =>
      noting(async () => {
        stopIfAborted("the wallet was asked to balance the transaction");
        report("balancing");
        return call();
      }),
    ),
    midnightProvider: around(providers.midnightProvider, "submitTx", (call) =>
      noting(async () => {
        stopIfAborted("the transaction was handed to the wallet to send");
        progress.handedOver = true;
        report("submitting");
        const txId = (await call()) as string;
        progress.accepted = true;
        report("submitted", txId);
        return txId;
      }),
    ),
  };
}

/**
 * Runs `call` on providers that report its steps, and turns any failure into a
 * {@link ShieldedPoolError} that says whether the transaction might have been sent.
 */
export async function track<T>(
  providers: Ledger9ContractProviders,
  options: CallOptions,
  call: (providers: Ledger9ContractProviders) => Promise<T>,
): Promise<T> {
  const progress: Progress = { handedOver: false, accepted: false };
  try {
    if (options.signal?.aborted) {
      throw new ShieldedPoolError("Stopped before it started", "failed", { cause: options.signal.reason });
    }
    return await call(observe(providers, options, progress));
  } catch (error) {
    throw classify(error, progress);
  }
}
