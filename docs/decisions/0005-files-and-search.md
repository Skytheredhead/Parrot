# ADR 0005: File storage and permission-safe search

- **Status:** Proposed; provider, limits, retention, and any external search engine require user approval
- **Date:** 2026-07-11
- **Scope:** Uploads, object access, file processing, cleanup, indexing, and search authorization

## Context

SpacetimeDB is authoritative for active product state, but large binary objects do not belong in subscriptions or reducer transactions. Search must cover messages, posts, tasks, and clean attachment text without making a lagging secondary index an authorization authority. Upload and indexing work is nondeterministic and therefore belongs in the gateway/worker tier defined by ADR 0001.

## Decision

### Provider-neutral object storage

Implement a narrow `ObjectStore` adapter supporting scoped upload creation, multipart abort, metadata lookup, streaming read, server-side copy, short-lived download signing, deletion, and prefix listing. The product stores opaque provider/bucket/key references, never permanent public URLs. The first adapter should target an S3-compatible managed service; Cloudflare R2 and AWS S3 are candidates. Vercel Blob is also viable if its operational coupling and self-hosted credential model are accepted. Self-hosted object storage requires a separate capacity and failure-domain review.

**The user must approve the provider, account, region/data residency, bucket names, lifecycle/retention policy, cost ceiling, and backup destination before provisioning.** The quarantine and clean stores use separate prefixes or buckets and least-privilege credentials. Public buckets are prohibited.

SpacetimeDB stores the object key, storage adapter, content version, workspace/space, uploader, original display name, byte size, checksum/ETag, detected media type, scan engine/version/result, lifecycle state, and deletion timestamps. It never stores signed URLs or storage credentials.

### Upload and processing lifecycle

1. The gateway generates an opaque random object key, and an authenticated reducer authorizes the workspace/space, checks current quota, declared size, and permitted type, and persists that key in an expiring `pending` upload ticket. The reducer does not generate randomness or perform storage I/O.
2. The gateway reauthorizes the ticket and issues a short-lived PUT or multipart capability scoped to the exact quarantine key. Where supported, the signature binds content type, checksum, and size. The client never chooses the storage key.
3. The client uploads directly to quarantine and calls completion. The gateway verifies object metadata rather than trusting the client.
4. A leased worker streams the object through magic-byte type detection, allowlists, size/decompression limits, archive policy, malware scanning, and safe transformation. Images are re-encoded with metadata stripped; PDF/Office content-disarm-and-reconstruction may be added after product/type approval. Executables, active HTML, SVG, and ambiguous polyglots are rejected initially.
5. A clean result is copied to an immutable clean key and recorded by an authorized completion reducer. Only `clean` objects can be attached, previewed, extracted, indexed, or downloaded. Rejected objects remain inaccessible and are deleted after a short diagnostic retention window.

The initial file-type allowlist, per-file/workspace quota, quarantine retention, malware engine/provider, and whether Office/PDF files are accepted **require user approval**. A malware scan is an integration control, not a guarantee that content is safe.

### Download and preview

Every request reaches the gateway first. It performs a live SpacetimeDB authorization check against the current membership, space privacy, file lifecycle, and authorization epoch, then returns a 30–60 second signed GET capability. These links are bearer capabilities and cannot be revoked before expiry, so they are never logged, cached in product state, or embedded in durable messages.

Downloads default to attachment disposition with the sanitized display name. Inline rendering is limited to explicitly safe, transformed types and uses `nosniff`, a restrictive content security policy, and sandboxed previews. Storage origins do not receive application cookies.

### Cleanup and reconciliation

A scheduled, idempotent worker aborts expired multipart uploads and deletes expired tickets, quarantined failures, unreferenced objects, and clean objects whose tombstone retention has elapsed. It compares authoritative metadata with provider listings and records discrepancies without deleting uncertain objects automatically. All cleanup actions are auditable and retryable. Deletion propagation has an age metric and dead-letter queue.

### Search without an authorization leak

SpacetimeDB remains authoritative. Sensitive base tables are private; caller-aware Views or the authorized gateway expose reads. Experimental RLS is not used.

The alpha starts with bounded, indexed exact/prefix/token search in the dedicated SpacetimeDB 2.6.1 deployment if preflight load tests meet latency/memory targets. Attachment text becomes searchable only after the object is clean and an extraction worker records its source content version.

An external full-text engine is a later, derived accelerator and **requires a separate ADR plus user approval of provider/engine, hosting, cost, region, and retention**. It must use this protocol:

1. The content reducer commits the mutation and a unique `search_outbox` row in one transaction; there is no application-level dual write.
2. A worker claims the row, upserts or tombstones a deterministic document ID at a monotonic content version, then acknowledges through a reducer. Replays are idempotent.
3. Reconciliation compares authoritative versions with indexed versions. A complete index can be rebuilt from SpacetimeDB and clean extracted text; the index is never restored as authority.
4. Search failure does not block core writes. The UI reports unavailable or stale search when lag breaches the selected threshold.

The external engine is server-only. Each document contains only necessary searchable content and tenant/resource/version/visibility identifiers—never secrets, credentials, signed URLs, or quarantined text.

For every query, the gateway obtains the caller's current authorized workspace/space/DM scopes from SpacetimeDB and sends a restrictive filter to the engine. Returned candidates are then reauthorized individually against current authoritative state **before** any title, snippet, preview, facet, or count is disclosed. The gateway overfetches and paginates until it has enough authorized results. DM documents are partitioned/filterable by exact current membership. Revocation blocks results immediately at the final check even while a priority tombstone is still propagating.

### Required evidence before production

- Direct upload cannot escape its exact key, size, type, expiry, or workspace quota.
- Spoofed MIME, polyglots, decompression bombs, malware, failed scans, and interrupted multipart uploads remain inaccessible and are cleaned up.
- Guessed keys, stale signed URLs, membership removal, private-space removal, and cross-tenant IDs cannot expose bytes or metadata.
- Search cannot leak snippets, titles, counts, facets, DM membership, deleted content, or attachment text before live authorization.
- Duplicate/out-of-order index jobs converge; deletion and permission propagation are measured; a full rebuild succeeds from authoritative state.

Track pending/quarantine age, scan duration/failure, orphan count, deletion lag, storage bytes/cost, oldest search outbox age, dead letters, indexed-version lag, final-authorization rejects, query p95, and rebuild age.

## Alternatives rejected

- **Binary payloads in normal SpacetimeDB rows:** large rows increase transaction, memory, and subscription cost.
- **Permanent or public object URLs:** possession would bypass current authorization.
- **Trust client filename, MIME, checksum, or completion:** each is attacker-controlled.
- **Index directly inside a reducer or dual-write to a search API:** external effects can fail or replay independently of the transaction.
- **Use search filters as the only permission check:** an index can lag permission and deletion changes.

## Current official evidence

Accessed 2026-07-11:

- [SpacetimeDB file-storage guidance](https://spacetimedb.com/docs/tables/file-storage/)
- [SpacetimeDB Views](https://spacetimedb.com/docs/functions/views/)
- [SpacetimeDB reducer transactions](https://spacetimedb.com/docs/functions/reducers/)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [Cloudflare R2 presigned URL behavior](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Vercel Blob](https://vercel.com/docs/vercel-blob)
- [Vercel Blob security](https://vercel.com/docs/vercel-blob/security)
