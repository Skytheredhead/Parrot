import type { JobKind } from "./domain.js";

/**
 * Runtime provenance for handlers constructed by this package's reviewed factories.
 *
 * The WeakMap is deliberately module-private: handlers cannot opt themselves into
 * production by copying a public symbol or declaring a dependency list.
 */
interface ReviewedHandlerRecord {
  readonly kinds: ReadonlySet<JobKind>;
  readonly prototype: object | null;
  readonly execute: unknown;
  readonly reconcile: unknown;
  readonly dependencies: unknown;
}

const reviewedHandlers = new WeakMap<object, ReviewedHandlerRecord>();

export const markReviewedHandler = <T extends object>(handler: T, kinds: readonly JobKind[]): T => {
  if (reviewedHandlers.has(handler)) throw new Error("handler_already_reviewed");
  const candidate = handler as Readonly<Record<string, unknown>>;
  if (typeof candidate.execute !== "function" || typeof candidate.reconcile !== "function") {
    throw new Error("reviewed_handler_contract_invalid");
  }
  const execute = candidate.execute.bind(handler);
  const reconcile = candidate.reconcile.bind(handler);
  Object.defineProperties(handler, {
    execute: { value: execute, enumerable: false, writable: false, configurable: false },
    reconcile: { value: reconcile, enumerable: false, writable: false, configurable: false },
  });
  if (Array.isArray(candidate.dependencies)) Object.freeze(candidate.dependencies);
  reviewedHandlers.set(handler, {
    kinds: new Set(kinds),
    prototype: Object.getPrototypeOf(handler),
    execute,
    reconcile,
    dependencies: candidate.dependencies,
  });
  return Object.freeze(handler);
};

export const isReviewedHandler = (handler: object, kind: JobKind): boolean => {
  const review = reviewedHandlers.get(handler);
  if (!review) return false;
  const candidate = handler as Readonly<Record<string, unknown>>;
  return (
    review.kinds.has(kind) &&
    Object.isFrozen(handler) &&
    Object.getPrototypeOf(handler) === review.prototype &&
    candidate.execute === review.execute &&
    candidate.reconcile === review.reconcile &&
    candidate.dependencies === review.dependencies
  );
};
