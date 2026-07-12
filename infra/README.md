# Provider-neutral self-hosted operations

This directory is a guarded deployment candidate, not a release authorization. It creates only dedicated `project-conversation-production` or `project-conversation-staging` Compose projects. It does not SSH to a host, modify Nginx, tunnels, TLS, firewall, DNS, publish a SpacetimeDB module, or operate the audited unrelated SpacetimeDB service on port `4789`.

## Layout

- `compose.yaml`: isolated, loopback-only SpacetimeDB baseline plus opt-in gateway, worker, and telemetry profiles. The worker profile has no host port and remains unreachable until explicitly selected.
- `env/*.env.example`: separate production and staging identities, ports, paths, and placeholder provider values. They contain no secrets.
- `docker/gateway.Dockerfile` and `docker/worker.Dockerfile`: reproducible non-root build references. Neither is deployable until its reviewed durable adapter composition is included, the image is scanned/pushed, and its resulting digest replaces the placeholder.
- `nginx/backend.conf.template`: review-only public-route allowlist. No script installs it.
- `otel/collector.yaml`: opt-in OTLP trace forwarding to an approved endpoint. No diagnostic exporter is enabled.
- `scripts/`: dry-run-first validation, preflight, deployment, cold backup, isolated restore drill with bounded no-egress state verification, image upgrade, and image rollback.

## Safety model

Every mutating script requires both `--apply` and `--confirm` with the exact approved Compose project name and acquires one environment-wide `flock` in the private state directory. Scripts parse a private operator/root-owned environment file without `source` or `eval`, use an explicit Compose file/project, reject port `4789`, constrain bind paths below `/srv/project-conversation/<environment>`, validate every fixed parent against symlinks/untrusted ownership or modes, and inspect container ownership labels plus the exact `/stdb` mount before lifecycle operations. Private checksummed journals make gateway, backup, restore-drill, image-intent, and rollback phases visible after process death. Backup and restore-drill evidence is bound through private checksum/manifest sidecars and verified Ed25519 signatures. The current bounded marker is evidence only: it records initialization provenance while explicitly setting `current_module_code=NotVerified`, `traffic_eligible=false`, and `upgrade_eligible=false`. The upgrade script rejects it until trustworthy current-module binding and lifecycle/object/search/provider verification can produce a separately reviewed traffic-ready format.

Run static validation from the repository without creating directories or pulling images:

```bash
infra/scripts/validate-config.sh
infra/scripts/validate-config.sh --profile gateway --profile telemetry
infra/tests/static-safety.sh
```

On an approved target, copy an example to a root/operator-readable location outside the repository, replace every `.invalid` and zero digest, provision the documented directories and secret files, then use the [deployment runbook](../docs/operations/deployment-runbook.md). All operational commands print a non-mutating plan unless explicitly confirmed.

The baseline deploy starts only SpacetimeDB. Gateway and telemetry require explicit profiles and runtime approval checks. Gateway replacement persists `prepared`, `applied`, and `committed` phases; it never claims it can reconstruct a prior configuration from an image name. An interrupted change fails closed until the operator independently verifies staging/current configuration and explicitly runs the reconciliation mode. Telemetry uses a separate internal network and cannot join the SpacetimeDB backend network. The worker is an unselected Compose profile, has no host port, and is not accepted by any deployment script. Its base image fails closed without `WORKER_ADAPTER_MODULE`, and runtime validation rejects the documented module/image placeholders. It may be enabled only after the complete durable adapter graph, provider secrets, authority job protocol, and staging recovery tests are approved.
