# Object-storage integration review — 2026-07-12

## Verdict

The deployed gateway and worker cannot complete one file lifecycle because they neither mount the
same directory nor implement the same storage format.

- Gateway mounts `GATEWAY_STATE_DIR` at `/var/lib/parrot/gateway`, uses that as
  `LOCAL_OBJECT_ROOT`, and stores payloads below hashed `objects/<prefix>/<key-hash>/<uuid>` paths
  plus immutable JSON heads below `heads/<prefix>/<key-hash>.json`.
- Worker mounts `OBJECT_DATA_DIR` at `/var/lib/parrot/data/objects` and treats each authority object
  key as a literal relative payload path. It has no knowledge of gateway heads or UUID version
  paths.
- Worker clean writes return a SHA-256 content hash as `objectVersion`, and the Spacetime adapter
  records that same value as both object version and checksum. Gateway descriptors and capability
  payloads currently require `objectVersion` to be a UUID.

Consequences: the worker cannot read a quarantine upload, its clean output cannot be opened by the
gateway, and cleanup cannot enumerate/delete the gateway representation. Unit tests pass because
each component is tested only against its own incompatible adapter.

## Smallest safe shared contract

Create one filesystem object-store implementation in a shared package and use it from both gateway
and worker. Do not maintain two implementations that merely aim at the same directory.

Use one host root, `OBJECT_DATA_DIR`, mounted read/write into both containers at the same path,
recommended `/var/lib/parrot/objects`. Set gateway `LOCAL_OBJECT_ROOT` and worker object-store root
to that exact container path. Keep `GATEWAY_STATE_DIR` separate for SQLite and other gateway state.
Both images already run as UID/GID `10001:10001`; preflight must require the shared root to be owned
by 10001, mode 0700, a real directory, and not a symlink.

The least disruptive canonical disk format is the gateway's existing hashed-head layout:

```text
<root>/
  heads/<keyHash[0:2]>/<keyHash>.json
  objects/<keyHash[0:2]>/<keyHash>/<versionTag>
  tmp/<operationId>.part
  tmp/<operationId>.json
```

`keyHash = hex(sha256(UTF8(canonicalLogicalKey)))`. The immutable head schema is:

```json
{
  "schemaVersion": 1,
  "objectKey": "files/<workspace>/<file>/quarantine/1",
  "objectVersion": "<64 lowercase hex SHA-256>",
  "sizeBytes": 123,
  "contentType": "text/plain",
  "checksumSha256": "<same 64 lowercase hex SHA-256>"
}
```

Standardize `objectVersion` on the lowercase SHA-256 of the exact payload, equal to
`checksumSha256`, for both quarantine and clean objects. The signed upload already binds the
expected checksum, so the gateway can use it as the version tag rather than generating a UUID.
This matches the worker/Spacetime contract and gives conditional operations one stable value.

Required shared operations:

- `putImmutable(logicalKey, contentType, expectedBytes, expectedSha256, stream)` streams to an
  exclusive temp file, checks length/hash, fsyncs it, hard-links the payload version without
  replacement, writes/fsyncs the strict descriptor, then publishes the descriptor without
  replacement. Browser capability ingress remains strictly single-use and returns conflict if the
  head already exists. The internal idempotent worker-clean operation may return the existing exact
  matching identity; any different descriptor or bytes at the same logical key is an immutable
  conflict.
- `openExact(logicalKey, versionTag)` reads and strictly validates the descriptor, opens the exact
  payload with `O_NOFOLLOW`, checks regular-file type and size, and streams it. Security-sensitive
  reads should verify the content hash or use a prior verified immutable identity; the cross-system
  acceptance test must hash it.
- `statExact(logicalKey)` returns descriptor identity, not a hash of an arbitrary logical path.
- `list(prefix)` enumerates validated descriptors and returns logical keys whose canonical value
  starts with the authority-supplied prefix. Because heads are hashed, this is a bounded descriptor
  walk; reject corrupt descriptors and symlinks. A later index may optimize it, but may not become
  authority.
- `deleteIfMatch(logicalKey, versionTag)` reopens the descriptor, requires the exact version, removes
  payload and descriptor with crash reconciliation, and treats already-absent as success. A stale
  version must never delete a newer/different object.

Do not let the worker write a raw logical-path file outside this format. Do not make gateway and
worker mounts overlap via two different roots. Do not paper over the issue with a symlink: both
adapters reject or fail to understand the other's representation.

## Interface changes required

1. Extract gateway key validation, descriptor validation, path derivation, immutable publication,
   exact read, list, stat, and conditional delete into the shared adapter.
2. Gateway capability ingress delegates upload/open to it. Change capability/descriptor
   `objectVersion` validation from UUID to 64-character lowercase SHA-256 and set upload version to
   the signed expected checksum.
3. Worker `FilesystemObjectStore` becomes a thin wrapper around the same adapter. Its
   `readStream`, `stat`, `list`, and `deleteIfMatch` consume logical keys; `writeClean` publishes a
   descriptor and returns the SHA-256 version tag.
4. Pass the worker's already-detected content type into clean publication. Prefer changing
   `writeClean(key, bytes, contentType, signal)` rather than fabricating metadata. The gateway must
   later verify the descriptor type against the authority-provided clean type before signing a
   download.
5. Mount `${OBJECT_DATA_DIR}` into gateway and worker at `/var/lib/parrot/objects`; set
   `LOCAL_OBJECT_ROOT=/var/lib/parrot/objects` and configure the worker to use the same root.
6. Add readiness checks that write/read/delete a private probe through the shared adapter only if a
   non-destructive probe namespace is explicitly supported. At minimum, validate format version,
   ownership, permissions, and read/write access from both containers.

## Mandatory cross-component acceptance test

One test must instantiate the real gateway capability store and real worker file handler over the
same temporary root. It should use public interfaces, not write fixture files directly:

1. Gateway signs a checksum-bound quarantine upload for a realistic authority key.
2. PUT the bytes through the actual Fastify capability route, in multiple chunks.
3. Gateway completion/head observes the SHA-256 version, exact size, and content type.
4. Real `FileProcessingHandler`, with deterministic clean scanner and fake authoritative plan,
   reads the quarantine logical key using the worker adapter, publishes the prescribed clean key,
   and records `objectVersion === checksumSha256`.
5. Gateway signs a clean download from that recorded authority identity; GET through the actual
   capability route returns byte-for-byte identical content, length, digest, type, ETag/version,
   and safe disposition.
6. Run extraction from the clean key and verify exact text, proving worker reads its own shared
   published format.
7. Run cleanup over the authority prefix. Verify quarantine and clean payload+descriptor removal,
   second cleanup idempotence, and gateway download becomes 404.
8. Adversarial assertions: mismatched checksum never publishes a head; stale version cannot delete;
   descriptor/key substitution, symlink insertion, malformed JSON, payload-size drift, content
   mutation, and concurrent different writes fail closed; exact replay converges without replacing
   bytes.

Run this test in CI and again in Compose with both production images and the real bind mount. The
Compose smoke should upload through the public edge, allow the actual worker/outbox to scan, poll
the caller-safe file view until clean, download through the edge, compare SHA-256, then delete and
verify cleanup. Only that second test proves mount ownership and container-path wiring.

## Release gate

Files remain disabled in the UI until both tests pass. Existing gateway and worker unit tests are
valuable but cannot be cited as file-pipeline evidence because they never exchange an object.
