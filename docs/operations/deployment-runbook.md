# Provider-neutral deployment runbook

Date: 2026-07-11

Status: Candidate runbook. No server mutation, provider provisioning, domain change, or release was performed while preparing it.

## Non-negotiable boundary

The audited host already serves unrelated applications through Docker, systemd, Nginx, and Cloudflare tunnels. It also has an unrelated SpacetimeDB service on port `4789`. This stack uses a dedicated Compose project, user, directories, networks, loopback ports, and labels. Never stop, restart, upgrade, mount, rename, proxy, or reuse the existing service or its data root. `shhh.skylarenns.com` is an SSH hostname, not an approved public application domain.

The scripts in `infra/scripts` are local-only. They contain no SSH target and make no Nginx, tunnel, firewall, TLS, DNS, or module-publication changes.

## Required decisions and evidence

Before any target-host setup, record approval for the shared host and capacity; final backend/frontend domains; OIDC and telemetry providers; secret-management process; alert recipients/on-call owner; maintenance window; RPO/RTO; backup retention/offsite destination; and the SpacetimeDB compatibility/migration plan. The host was observed with 148 GiB free but an 84%-used root disk; repeat disk, inode, swap, port, process, proxy, tunnel, backup, and monitoring inventory immediately before deployment.

Gateway activation additionally requires:

1. A reviewed production `GATEWAY_ADAPTER_MODULE` that composes durable SpacetimeDB, object, search, and provider adapters as applicable.
2. Tests for restart recovery, idempotency, tenancy/authorization, dependency timeouts, and readiness.
3. An immutable built image digest, SBOM, secret/dependency/container scans, and provenance record.
4. Real exact origins and OIDC URLs. The examples deliberately use `.invalid` and are rejected at runtime.
5. The exact source CIDR by which the dedicated host proxy reaches the gateway container. The
   examples use a rejected `192.0.2.1/32` TEST-NET placeholder; verify the real hop before trusting
   forwarded client addresses or using them for distributed abuse controls.
6. A reviewed real-client-IP chain for the direct SpacetimeDB WSS route. Record whether the hop is a
   Cloudflare tunnel or another trusted reverse proxy, the exact source CIDRs, and the authenticated
   client-IP header semantics. Runtime gateway-profile validation rejects
   `PUBLIC_WSS_REAL_IP_MODE=not-configured` and TEST-NET/empty trusted CIDRs. The Nginx template also
   contains an unrendered `__APPROVED_REAL_IP_DIRECTIVES__` token, so `nginx -t` fails until the exact
   `set_real_ip_from`/`real_ip_header` policy is supplied. Without this, per-IP WSS limits collapse all
   clients onto the tunnel/proxy address and are not a valid public control. Each comma-separated
   trusted hop must be a syntactically valid IPv4 or IPv6 CIDR with a bounded prefix; malformed or
   empty entries are rejected before Compose validation.

The gateway issues short-lived agent stream tickets but does not serve the returned WebSocket
route. `AGENT_STREAM_ORIGINS` must name a separately reviewed stream broker; the Nginx template in
this repository deliberately does not proxy `/v1/agent/runs/<id>/stream`.

The worker is not a deployable service. It remains disabled until a durable queue/outbox adapter composition exists and recovery behavior is proven.

## One-time target preparation

Use a dedicated, non-login deployment account and the least privileges needed for this Compose project. The operator—not the repository scripts—creates and owns these paths for exactly one environment:

```text
/srv/project-conversation/production/{spacetime,backups,state,config,secrets}
/srv/project-conversation/staging/{spacetime,backups,state,config,secrets}
/srv/project-conversation/restore-drills/{production,staging}/
```

Production and staging must not share owners where that would grant cross-environment secret access. Directories must be real paths, not symlinks. Keep secrets out of the repository and environment file. Place a random readiness token of at least 32 characters at the configured `GATEWAY_READINESS_TOKEN_FILE` with mode `0400` for the runtime operator. Copy `infra/otel/collector.yaml` to the environment's approved config path. Any telemetry authentication headers must be added through the selected secret mechanism after provider review; do not put them in Git.

Use mode `0700` for each `/srv/project-conversation/<environment>` root, its `spacetime`, `backups`,
and `state` directories, and the shared restore-drill parent. `/srv` and
`/srv/project-conversation` may be traversable but must not be group/other-writable. Use protected
operator/root ownership throughout. Runtime validation walks this fixed path chain and rejects
untrusted owners, symlinks, group/other-accessible private directories, and a gateway readiness secret readable by group/other or owned by
any identity other than root/the runtime operator. Mode `0400` or `0600` is acceptable for the
source secret file; confirm the Compose secret mount remains readable by the non-root gateway in the
staging image before production deployment.

Provision a dedicated Ed25519 evidence-signing keypair for each environment. Configure
`BACKUP_EVIDENCE_SIGNING_KEY_FILE` to a mode-`0400`/`0600` private key delivered by the approved
secret mechanism, and `BACKUP_EVIDENCE_VERIFY_KEY_FILE` to its reviewed public key (kept private by
the scripts as defense in depth). Do not reuse application, TLS, SSH, or provider keys. Backups and
restore drills sign their manifests/markers; upgrade accepts only evidence verified by this key.
Protect and recover the private key separately from the data backup, rotate it only with a documented
old-evidence verification plan, and remove it from the host between maintenance windows if the
operator workflow can mount it just in time.

Copy the appropriate `infra/env/*.env.example` to a mode-`0400`/`0600`, operator/root-owned target-local
file. Preserve the exact project name, environment, service paths, and non-`4789` ports. Replace every
`.invalid`, zero digest, adapter placeholder, and WSS real-IP placeholder before enabling the
corresponding profile. Runtime scripts reject group/other access to this file.

## Validate and inspect

Static repository validation is non-mutating:

```bash
infra/scripts/validate-config.sh
docker compose --project-name project-conversation-staging \
  --env-file infra/env/validation.env \
  --file infra/compose.yaml config
```

On the approved target, runtime validation and preflight are read-only. The preflight enforces the recorded Linux/amd64 platform, rejects an unlabeled container using the same Compose project name, and applies provisional safety floors of 25 GiB free disk, below 90% disk use, and below 90% inode use. Capacity approval may require stricter thresholds; do not weaken them to force a deployment.

```bash
infra/scripts/validate-config.sh --env-file /protected/path/production.env --runtime
infra/scripts/preflight.sh --env-file /protected/path/production.env
```

For a future approved gateway or telemetry deployment, add `--profile gateway` or `--profile telemetry` to both commands. Preflight fails on path, image, provider-placeholder, port, or ownership problems. It explicitly reports but never operates port `4789`.

## Build and identify the gateway candidate

`infra/docker/gateway.Dockerfile` uses the recorded Node digest and a non-root runtime. It loads `*_FILE` secrets before importing the gateway main module. It is only a build reference: the repository currently has no production adapter at `/app/adapter/index.js`, so the base image fails closed.

After adding the reviewed adapter through a derived build, build for the approved target platform, generate an SBOM, scan the result, push it to the approved registry, sign/attest as required, and record the registry-returned immutable digest. Put only `registry/path@sha256:<64 lowercase hex>` in the protected environment file. A Dockerfile base-image digest is not the gateway output-image digest.

## Deploy privately

The command below prints its plan and does nothing:

```bash
infra/scripts/deploy.sh --env-file /protected/path/production.env
```

After review, the explicit mutation is:

```bash
infra/scripts/deploy.sh \
  --env-file /protected/path/production.env \
  --apply \
  --confirm project-conversation-production
```

That baseline starts only the pinned SpacetimeDB service. It binds `127.0.0.1:39000`, uses only the dedicated bind root, applies restart/log/resource/PID limits, and waits for container health. It does not publish a module and does not indicate application readiness.

After the first healthy start, deployment records an integrity-checked reviewed image pin under the
environment `state` directory. Later deploy, backup, upgrade, and rollback operations read that
persistent pin instead of silently reverting to the image still written
in an older environment file. Treat the pin and checksum sidecar as reviewed operational state and
copy them with deployment evidence.

Only after all gateway gates pass:

```bash
infra/scripts/deploy.sh \
  --env-file /protected/path/production.env \
  --with-gateway \
  --apply \
  --confirm project-conversation-production
```

Telemetry is independently opt-in with `--with-telemetry`; the exporter endpoint and its data residency, retention, cost, authentication, and redaction must be approved first. The collector exposes no host ports and has no console/debug payload exporter.

Every mutating command for an environment uses the same non-blocking `flock` at
`state/operations.lock`; concurrent deploy, backup, restore drill, upgrade, or rollback attempts fail.
Gateway replacement persists `prepared`, `applied`, and `committed` phases before and after Compose
replacement. It does not save secret contents or claim it can recreate the prior configuration from
the prior image. After process death, a new deployment fails closed. Independently verify the target
environment and current container in staging, then explicitly reconcile:

```bash
infra/scripts/deploy.sh \
  --env-file /protected/path/production.env \
  --reconcile-gateway \
  --accept-current-gateway-config \
  --apply \
  --confirm project-conversation-production
```

Reconciliation commits a healthy recorded target or marks an untouched recorded prior image
abandoned; any mixed state requires manual staging repair. It never performs an automatic rollback
using current environment values as if they were the old configuration. Telemetry is
placed on a dedicated internal network shared only with the gateway, not on SpacetimeDB's backend
network. Deployment waits for the collector container health check when telemetry is requested. The
collector's configured health endpoint also evaluates pipeline/exporter failures; the in-container
Docker probe remains a configuration/process-start check because the pinned minimal collector image
does not include a separate HTTP probe client. Add an approved external/internal-network probe and
alert before treating telemetry as monitored.

## Public proxy change, only after approval

No deployment script installs `infra/nginx/backend.conf.template`. After domain, certificate, compatibility, rate/size, and existing-host proxy review:

1. Render all `__PLACEHOLDER__` tokens into a new dedicated Nginx file; never edit an unrelated server block. This includes reviewed positive integer values for `__WSS_CONNECTIONS_PER_IP__` and `__WSS_CONNECTIONS_TOTAL__`, sized from capacity and abuse testing, plus exact real-IP directives for the approved tunnel/proxy. Refuse installation while any `__...__` token remains.
2. Review the final diff. The allowlist exposes only the gateway's current exact `/v1` route shapes and the exact `/v1/database/<approved-database>/subscribe` WSS route to SpacetimeDB.
3. Leave `/v1/identity` commented unless the compatibility spike proves it necessary.
4. Confirm detailed readiness, publish, SQL, logs, delete, reducer call, admin, and unmatched `/v1/` routes return `404` externally.
5. Run `nginx -t`, obtain explicit approval, reload only Nginx, and test TLS/WSS plus denial routes. Do not alter Cloudflare tunnels or firewall rules incidentally.

The restricted route shape follows the [official SpacetimeDB self-hosting guidance](https://spacetimedb.com/docs/how-to/deploy/self-hosting/), with a stricter default deny.

## Post-deploy evidence

Verify loopback-only listeners, exact images, labels/mounts, health, restart count, memory/OOM, CPU, disk/inodes, JSON log rotation, and absence of public admin routes. For the application candidate, also verify login/session, exact-origin CORS, WSS reconnect/catch-up, reducer authorization, tenancy isolation, dependency failure/readiness, outbox leasing, file quarantine, and redaction before traffic.

Health means only the configured process dependency check passed. It is not launch approval, end-to-end readiness, backup proof, or recovery proof.

## Staging separation

Staging uses `project-conversation-staging`, ports `39100/39180`, and `/srv/project-conversation/staging`. It must have distinct OIDC identities, provider sandboxes, object prefixes/buckets, telemetry attributes, webhook endpoints, and secrets. Delivery to real email/push/webhooks stays suppressed. Preview clients must never receive production credentials.
