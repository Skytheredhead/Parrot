# Provider-neutral self-hosted operations

This directory is a guarded deployment candidate, not a release authorization. It creates only dedicated `project-conversation-production` or `project-conversation-staging` Compose projects. It does not SSH to a host, modify Nginx, tunnels, TLS, firewall, DNS, publish a SpacetimeDB module, or operate the audited unrelated SpacetimeDB service on port `4789`.

## Layout

- `compose.yaml`: isolated, loopback-only SpacetimeDB baseline plus opt-in gateway, Nginx edge, worker, ClamAV, Ollama loopback relay, and telemetry profiles. SpacetimeDB joins the egress-only network solely to fetch configured OIDC discovery/JWKS documents; it does not join telemetry. Worker, scanner, model relay, and telemetry have no host ports. The edge is the only intended Cloudflare origin and binds dedicated loopback port `39090` (production) or `39190` (staging).
- `env/*.env.example`: separate production and staging identities, ports, paths, and placeholder provider values. They contain no secrets.
- `docker/gateway.Dockerfile` and `docker/worker.Dockerfile`: reproducible non-root builds containing the reviewed repository-owned production compositions. Deployment still requires scanned/published output-image digests and private runtime configuration.
- `nginx/edge.conf.template`: container edge with an exact gateway route allowlist, one exact database subscription route, and a default deny. `nginx/backend.conf.template` remains an unused host-Nginx reference; the approved Parrot topology does not install it.
- `otel/collector.yaml`: opt-in OTLP trace forwarding to an approved endpoint. No diagnostic exporter is enabled.
- `scripts/`: dry-run-first validation, preflight, deployment, cold backup, isolated restore drill with bounded no-egress state verification, image upgrade, and image rollback. `systemd/` contains reviewed-but-uninstalled cold-backup and operator-gated rollback unit templates.

## Safety model

Every mutating script requires both `--apply` and `--confirm` with the exact approved Compose project name and acquires one environment-wide `flock` in the private state directory. Scripts parse a private operator/root-owned environment file without `source` or `eval`, use an explicit Compose file/project, reject port `4789`, constrain active state below `/srv/project-conversation/<environment>` and backups below `/mnt/bigboi/project-conversation/<environment>`, validate both path chains against symlinks/untrusted ownership or modes, and inspect container ownership labels plus the exact `/stdb` mount before lifecycle operations. Private checksummed journals make gateway, backup, restore-drill, image-intent, and rollback phases visible after process death. Backup and restore-drill evidence is bound through private checksum/manifest sidecars and verified Ed25519 signatures. The current bounded marker is evidence only: it records initialization provenance while explicitly setting `current_module_code=NotVerified`, `traffic_eligible=false`, and `upgrade_eligible=false`. The upgrade script rejects it until trustworthy current-module binding and lifecycle/object/search/provider verification can produce a separately reviewed traffic-ready format.

Run static validation from the repository without creating directories or pulling images:

```bash
infra/scripts/validate-config.sh
infra/scripts/validate-config.sh --profile gateway --profile edge --profile worker --profile scanner --profile telemetry
infra/tests/static-safety.sh
```

On an approved target, copy an example to a root/operator-readable location outside the repository, replace every `.invalid` and zero digest, provision the documented directories and secret files, then use the [deployment runbook](../docs/operations/deployment-runbook.md). All operational commands print a non-mutating plan unless explicitly confirmed.

The baseline deploy starts only SpacetimeDB. Every other service requires an explicit option and runtime approval checks. Gateway replacement persists `prepared`, `applied`, and `committed` phases; it never claims it can reconstruct a prior configuration from an image name. An interrupted change fails closed until the operator independently verifies staging/current configuration and explicitly runs the reconciliation mode. The edge joins only the private backend and exposes one loopback port. Telemetry cannot join the SpacetimeDB backend network. The worker and scanner remain unreachable from the host. Runtime validation rejects placeholder images and incomplete provider configuration. Optional email, export, rebuild, webhook, invitation, cookie-session, and gateway tool/stream surfaces remain explicitly disabled until their authorities are configured.
