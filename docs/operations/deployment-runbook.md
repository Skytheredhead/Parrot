# Provider-neutral deployment runbook

Date: 2026-07-12

Status: Reviewed deployment runbook. WorkOS staging resources and isolated host directories may be provisioned independently; a public route still requires the private-validation gates below.

## Non-negotiable boundary

The audited host already serves unrelated applications through Docker, systemd, Nginx, and Cloudflare tunnels. It also has an unrelated SpacetimeDB service on port `4789`. This stack uses a dedicated Compose project, user, directories, networks, loopback ports, and labels. Never stop, restart, upgrade, mount, rename, proxy, or reuse the existing service or its data root. `shhh.skylarenns.com` is an SSH hostname, not an approved public application domain.

The scripts in `infra/scripts` are local-only. They contain no SSH target and make no Nginx, tunnel, firewall, TLS, DNS, or module-publication changes.

## Required decisions and evidence

The shared host, `parrot.skylarenns.com` frontend, `parrotapi.skylarenns.com` backend, WorkOS identity provider, one-hour RPO, four-hour RTO, and `/mnt/bigboi` backup target are approved. Credentials never belong in this repository; provision them as private files or through the selected secret mechanism. The host was observed with 148 GiB free but an 84%-used root disk; repeat disk, inode, swap, port, process, proxy, tunnel, backup, and monitoring inventory immediately before deployment.

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

The worker process host and non-root image are opt-in and have no host port. The repository-owned
production composition uses WorkOS M2M identity, caller-scoped Spacetime authority, SQLite search,
filesystem objects, ClamAV, and the host-local Ollama bridge. Email, full search rebuild, workspace
export materialization, and agent tools are deliberately fail-closed until their missing provider or
authority inputs are configured. Runtime validation rejects another adapter path or placeholder image.

## One-time target preparation

Use a dedicated, non-login deployment account and the least privileges needed for this Compose project. The operator—not the repository scripts—creates and owns these paths for exactly one environment:

```text
/srv/project-conversation/production/{spacetime,clamav,state,config,secrets}
/srv/project-conversation/staging/{spacetime,clamav,state,config,secrets}
/srv/project-conversation/restore-drills/{production,staging}/
/mnt/bigboi/project-conversation/production/backups/
/mnt/bigboi/project-conversation/staging/backups/
```

Production and staging must not share owners where that would grant cross-environment secret access. Directories must be real paths, not symlinks. Keep secrets out of the repository and environment file. Place a random readiness token of at least 32 characters at the configured `GATEWAY_READINESS_TOKEN_FILE` with mode `0400` for the runtime operator. Copy `infra/otel/collector.yaml` to the environment's approved config path. Any telemetry authentication headers must be added through the selected secret mechanism after provider review; do not put them in Git.

Provision an independent random object-capability HMAC value of at least 32 bytes at
`OBJECT_CAPABILITY_HMAC_SECRET_FILE`. The Compose secret is mounted read-only, while the gateway
configuration retains the file path so the object adapter can enforce size/mode checks itself. The
entrypoint dereferences only `READINESS_TOKEN_FILE`; it deliberately does not convert arbitrary
`*_FILE` references into environment secret values.

Use mode `0700` for each `/srv/project-conversation/<environment>` root, its `spacetime`, `clamav`, and `state`
directories, each `/mnt/bigboi/project-conversation/<environment>` root and `backups` directory, and the shared restore-drill parent. `/srv`, `/mnt/bigboi`, and
`/srv/project-conversation` may be traversable but must not be group/other-writable. Use protected
operator/root ownership throughout. Runtime validation walks this fixed path chain and rejects
untrusted owners, symlinks, group/other-accessible private directories, and a gateway readiness secret readable by group/other or owned by
any identity other than root/the runtime operator. Mode `0400` or `0600` is acceptable for the
source secret file; confirm the Compose secret mount remains readable by the non-root gateway in the
staging image before production deployment.

Create `state/gateway`, `state/worker`, `state/objects`, `state/exports`, and
`state/worker/ollama-bridge` as real mode-`0700` directories owned by numeric UID `10001`, matching
the immutable gateway/worker images. Runtime validation rejects a symlink, broader mode, or different
owner. The read-only containers receive only their exact writable bind paths: gateway capability
state, worker SQLite state, worker objects, and worker exports. They do not receive the environment
root, configuration directory, secrets directory, or backup tree.

Copy `infra/clamav/clamd.conf` to the configured private config path. ClamAV and the worker share only
the project-owned `clamav-runtime` volume containing `/run/clamav/clamd.sock`; no ClamAV TCP listener
is exposed to the host or another Docker network. The socket is world-connectable only inside that
two-container volume, while both containers otherwise retain dropped capabilities and isolated
networks.

Provision a dedicated Ed25519 evidence-signing keypair for each environment. Configure
`BACKUP_EVIDENCE_SIGNING_KEY_FILE` to a mode-`0400`/`0600` private key delivered by the approved
secret mechanism, and `BACKUP_EVIDENCE_VERIFY_KEY_FILE` to its reviewed public key (kept private by
the scripts as defense in depth). Do not reuse application, TLS, SSH, or provider keys. Backups and
restore drills sign their manifests/markers; upgrade accepts only evidence verified by this key.
Protect and recover the private key separately from the data backup, rotate it only with a documented
old-evidence verification plan, and remove it from the host between maintenance windows if the
operator workflow can mount it just in time.

Restore-state verification also requires the reviewed database name, exact database identity,
exact initialization-program hash, canonical module-schema SHA-256, and a mode-`0400`/`0600`
database-owner token at the fixed
environment secret path shown in the env example. The token must identify the database publisher and
also satisfy the module's immutable OIDC issuer/audience connection policy. The verifier sends it only to the reserved
loopback drill port, never exposes it on a command line, and removes its private transient SQL files.
Provision the token separately from backups and application/service credentials. A successful v4
marker is bounded restore evidence only and explicitly remains ineligible for production traffic or
live upgrades. The database endpoint exposes initialization provenance, not a trustworthy hash of
code installed by a later republish, so the marker records `current_module_code=NotVerified` while
deletion lifecycle, objects, search, and providers remain `NotConfigured`.

Copy the appropriate `infra/env/*.env.example` to a mode-`0400`/`0600`, operator/root-owned target-local
file. Preserve the exact project name, environment, service paths, and non-`4789` ports. Replace every
`.invalid`, zero digest, adapter placeholder, and WSS real-IP placeholder before enabling the
corresponding profile. Runtime scripts reject group/other access to this file.

`BACKUP_MOUNT_OWNER_UID` must be the verified numeric owner of the fixed `/mnt/bigboi` mount. Only
that mount root receives this additional ownership allowance, and it must still reject group/other
write access. Descendant Parrot backup directories remain private to the runtime operator.

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

For the full candidate, add `--profile gateway --profile edge --profile worker --profile scanner --profile telemetry` to both commands. Preflight fails on either filesystem, image, provider-placeholder, reserved-port, ownership, container/network collision, or unsafe edge-config problems. It explicitly reports but never operates port `4789`.

## Build and identify the gateway candidate

`infra/docker/gateway.Dockerfile` uses the recorded Node digest and a non-root runtime. It builds the generated Spacetime bindings and includes the reviewed adapter at `/app/dist/production/parrot.js`. The adapter enables bearer OIDC, caller-scoped authority, files/object capabilities, SQLite rate limits, and HMAC cursors; unsupported provider routes remain explicitly fail-closed.

Build for the approved target platform, generate an SBOM, scan the result, push it to the approved registry, sign/attest as required, and record the registry-returned immutable digest. Put only `registry/path@sha256:<64 lowercase hex>` in the protected environment file. A Dockerfile base-image digest is not the gateway output-image digest.

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

The full private candidate adds `--with-edge --with-worker --with-scanner --with-telemetry`. `--with-edge` also selects the gateway. Production reserves loopback ports `39000` (SpacetimeDB), `39080` (gateway diagnostics/origin), and `39090` (the only Cloudflare origin). Staging reserves `39100`, `39180`, and `39190`. The worker, ClamAV, collector, and Ollama loopback relay have no host listeners. ClamAV signatures use the dedicated `/srv` bind directory. All services and the isolated runtime-socket volume carry project/environment ownership labels and bounded PID, memory, CPU, and JSON-log settings.

Ollama remains bound to host loopback. Never widen it to `0.0.0.0`, a LAN address, or a Docker bridge.
Install `infra/systemd/parrot-ollama-bridge@.service` only after reviewing the host `socat` package and
the exact `parrot` UID. The native unit converts `127.0.0.1:11434` to a mode-`0600` Unix socket below
the worker state directory. A tiny pinned sidecar shares only the worker network namespace and converts
that socket back to container-loopback `127.0.0.1:11434`, satisfying the provider's hard local-only
endpoint check. Runtime worker validation requires the socket to exist, so the profile fails closed
when the native bridge is absent. Verify `curl http://127.0.0.1:11434/api/tags` on the host, start
`parrot-ollama-bridge@production`, then validate the worker profile; do not configure a host TCP proxy.

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

## Cloudflare tunnel change, only after private validation

The Compose edge replaces any host-Nginx change for Parrot. Do not add a host `:80`/`:443` server block and do not edit any unrelated Nginx file. After the private production stack is healthy:

1. Make a private timestamped backup of the existing Cloudflare tunnel config and record its checksum, mode, owner, and current service status. Never print the file because it may contain a tunnel credential path or token.
2. Confirm `cloudflared tunnel ingress validate` succeeds before editing. Add exactly one hostname rule for `parrotapi.skylarenns.com` pointing to `http://127.0.0.1:39090`, immediately before the existing catch-all. Do not reorder, rewrite, or normalize the roughly fifty unrelated ingress entries.
3. Validate again, inspect the exact diff, and prove every unrelated line is byte-for-byte unchanged. Reload only the existing Cloudflare tunnel unit; never restart Docker, host Nginx, firewall, the unrelated SpacetimeDB service, or another tunnel.
4. Verify HTTPS and WSS through the public hostname. Confirm readiness, identity, publication, SQL, logs, delete, reducer call, admin, and unmatched routes return `404`; the exact gateway routes and `/v1/database/project-conversation-production/subscribe` are the only positive surface.
5. On any failure, restore the exact backed-up tunnel config, validate it, reload only the same tunnel unit, and verify all pre-existing hostnames. Keep the failed candidate private until the root cause is understood.

The restricted route shape follows the [official SpacetimeDB self-hosting guidance](https://spacetimedb.com/docs/how-to/deploy/self-hosting/), with a stricter default deny.

## Post-deploy evidence

Verify loopback-only listeners, exact images, labels/mounts, health, restart count, memory/OOM, CPU, disk/inodes, JSON log rotation, and absence of public admin routes. For the application candidate, also verify login/session, exact-origin CORS, WSS reconnect/catch-up, reducer authorization, tenancy isolation, dependency failure/readiness, outbox leasing, file quarantine, and redaction before traffic.

Health means only the configured process dependency check passed. It is not launch approval, end-to-end readiness, backup proof, or recovery proof.

## Staging separation

Staging uses `project-conversation-staging`, ports `39100/39180/39190`, `/srv/project-conversation/staging`, and `/mnt/bigboi/project-conversation/staging/backups`. It must have distinct OIDC identities, provider sandboxes, object prefixes/buckets, telemetry attributes, webhook endpoints, and secrets. Delivery to real email/push/webhooks stays suppressed. Preview clients must never receive production credentials.
