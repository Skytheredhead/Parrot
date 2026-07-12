# Deployment image provenance record

Verified: 2026-07-11

These are candidate input pins, not proof of vulnerability status, application compatibility, runtime health, production readiness, or future freshness. Re-resolve and review manifests for every platform/version change, then scan/sign/attest the actual output images used in a release.

| Purpose | Exact candidate reference | Scope/status |
| --- | --- | --- |
| SpacetimeDB | `clockworklabs/spacetime:v2.6.1@sha256:53100591a8bfd62c6e088e801b68e96871a8fc6e68eb4fb031bc6ac76f77a72e` | Exact Linux/amd64 manifest selected by the audited production plan. Used by the baseline Compose service. Do not substitute this into or upgrade the existing unrelated host service. |
| Gateway/worker Node base | `node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5` | Official Node base input for both process Dockerfiles. Each finished image requires its own registry digest; this pin is not either output digest. |
| OpenTelemetry Collector Contrib | `otel/opentelemetry-collector-contrib:0.156.0@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108` | Collector candidate used only by the opt-in telemetry profile. Destination/provider approval remains required. |

Official image sources accessed 2026-07-11:

- [SpacetimeDB repository and Docker usage](https://github.com/clockworklabs/SpacetimeDB)
- [Official Node Docker image](https://hub.docker.com/_/node)
- [OpenTelemetry Collector Contrib image](https://hub.docker.com/r/otel/opentelemetry-collector-contrib)

The environment examples intentionally use non-runnable gateway and worker placeholders:

```text
registry.invalid/project-conversation/gateway@sha256:0000000000000000000000000000000000000000000000000000000000000000
registry.invalid/project-conversation/worker@sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Runtime validation rejects these values. The gateway placeholder is replaced only after the durable adapter composition is included and the built image is scanned, pushed, and identified by registry digest. The worker remains disabled even if a placeholder is replaced; enabling it requires a separately reviewed Compose change and durable adapter evidence.

The protected environment file is the reviewed initial pin only. After the first healthy deployment,
the operations scripts persist the active SpacetimeDB digest, signed-time pair, reason, and transition
identifier in `/srv/project-conversation/<environment>/state/spacetimedb-image-pin.env` with a checksum
sidecar. Upgrade and rollback first persist a checksummed transaction, then atomically advance the
intent pin, apply the container image, verify health, and commit the transaction phase. A process death
therefore leaves enough intent and checksum evidence to resume the same transition without inferring a
target from a mutable environment file or file mtime. Preserve the pin, transaction journal, reasons,
transition identifiers, and checksum sidecars in release evidence.

Checksummed operational records also use a private publication-intent file while replacing the record
and sidecar. If the operator process dies between those two renames, verification accepts the new
record only when its exact digest matches that durable intent; the next successful phase write
finalizes the sidecar. A mismatched record without matching intent remains fail-closed.
