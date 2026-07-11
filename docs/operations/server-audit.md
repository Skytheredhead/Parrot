# Server audit and proposed isolation plan

Date: 2026-07-11

Host inspected through the existing SSH configuration: `shhh.skylarenns.com`

This hostname is treated only as an SSH endpoint. It is not approved as a public application hostname.

## Read-only findings

- Operating system: Ubuntu 24.04.4 LTS.
- Capacity: 16 logical CPUs, 31 GiB RAM, 8 GiB swap.
- Root filesystem: 937 GiB total, 148 GiB available, 84% used.
- Docker and systemd are active.
- Nginx and Cloudflare tunnels already serve unrelated applications.
- SpacetimeDB is already running as a system service on port 4789.
- The existing SpacetimeDB service uses a user-owned data directory and currently runs as the login user.
- Multiple unrelated databases, media services, monitoring tools, game services, and web applications share the host.
- The SSH user can inspect Docker without sudo.
- No server mutation was performed during the audit.

## Important constraints

- Do not interrupt, reconfigure, upgrade, or reuse the existing SpacetimeDB service until its current consumers are mapped.
- Do not bind a new service to an existing public port.
- Do not modify existing Docker networks or volumes.
- Do not alter Nginx, Cloudflare tunnels, firewall rules, or TLS until a public backend domain is approved.
- Do not use the attached credential unless an operation genuinely requires sudo and a non-exposing interactive mechanism is available.
- Disk and swap pressure require explicit resource limits, log rotation, backup retention, and capacity alerts.

## Proposed production isolation

The preliminary recommendation is a dedicated Compose project under a user-writable directory, with:

- a separately pinned SpacetimeDB 2.x instance bound to localhost only;
- a dedicated operational volume and backup target;
- an application gateway/worker bound to localhost only;
- an isolated Docker network;
- CPU and memory limits;
- health and readiness checks;
- structured logs with rotation;
- no host port exposure beyond a future reverse-proxy route;
- a distinct staging Compose project and volumes when capacity permits.

The existing SpacetimeDB host may still be reused if a later compatibility and blast-radius review proves that safer than a separate instance. No decision will be made merely for convenience.

## Required approvals before public deployment

1. Final product name.
2. Dedicated HTTPS/WSS backend domain.
3. GitHub account or organization, repository name, and visibility.
4. Vercel account/project access or confirmation of an existing linked project.
5. Email provider and sender domain.
6. Object-storage provider and bucket.
7. Authentication provider if a managed OIDC service is selected.

## Next inspection before mutation

- Confirm exact SpacetimeDB versions and current database consumers.
- Identify unused localhost ports.
- Review only the relevant reverse-proxy include structure.
- Measure sustained memory, swap, and disk pressure.
- Select a deployment directory and backup destination.
- Produce a concrete change plan and rollback procedure.
