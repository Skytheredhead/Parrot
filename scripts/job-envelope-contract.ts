import type { OutboxJobEnvelopeView, SearchWorkItem } from "../packages/db-bindings/src/types.js";
import type {
  SpacetimeOutboxEnvelope,
  SpacetimeSearchWorkItem,
} from "../services/worker/src/spacetime-outbox.js";

type AssertAssignable<T extends U, U> = T;

export type GeneratedEnvelopeMatchesWorkerDecoder = AssertAssignable<
  OutboxJobEnvelopeView,
  SpacetimeOutboxEnvelope
>;

export type GeneratedSearchWorkMatchesWorkerDecoder = AssertAssignable<
  SearchWorkItem,
  SpacetimeSearchWorkItem
>;
