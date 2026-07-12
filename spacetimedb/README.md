# Authoritative SpacetimeDB module

This Rust module is the transactional authority for active collaboration state. It targets
SpacetimeDB `2.6.1` exactly. All base tables are private; browser clients receive only caller-aware
public Views and can invoke reducers whose authorization is enforced inside the transaction.

## Toolchain

- Rust `1.93.0`, pinned in `rust-toolchain.toml`
- `wasm32-unknown-unknown`
- SpacetimeDB Rust crate `=2.6.1`
- SpacetimeDB CLI `2.6.1`, installed from checksum-pinned official release assets

On machines where Homebrew Rust appears before the rustup shim, prepend the shim explicitly:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.93.0
```

## Bootstrap build configuration

A fresh database is provisioned by the module's non-callable `init` reducer. The module must be
compiled or published with all three environment variables below:

- `PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER`: the exact OIDC issuer. Production issuers must use HTTPS;
  only the parsed host `localhost` may use HTTP for local development. Userinfo, query, fragment,
  backslash, percent-encoding, and malformed ports are rejected.
- `PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE`: the exact, whitespace-free OIDC audience.
- `PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ADDITIONAL_AUDIENCES`: optional comma-separated exact
  audiences (at most seven) issued by the same immutable issuer. This supports separate browser and
  machine Connect clients without trusting a second issuer. Empty values, duplicates, whitespace,
  commas inside an audience, and more than eight total audiences are rejected.
- `PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT`: the exact OIDC `sub` claim of the identity authorized to create
  the initial owner and workspace.

The values are read through tracked `option_env!` calls, so changing one invalidates the Cargo
artifact. Missing or invalid values cause the database initialization transaction, and therefore a
fresh publish, to fail. There is no public reducer for provisioning bootstrap authority.

All three values are non-secret identity configuration. Obtain the subject from a verified token or
the identity provider's administrative console, and bind it to the exact issuer and audience used by
this deployment:

```bash
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER='https://id.your-company.com'
export PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE='project-conversation-production'
export PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT='oidc|owner-123'
```

`bootstrap_owner` accepts no caller-supplied authority proof. It requires a valid token for the
compiled issuer/audience and compares the signed `sub` claim exactly with the compiled owner
subject. The bootstrap authority is single-use and is marked consumed atomically with
owner/workspace creation. Bootstrap also binds the private platform operator authority to the
verified subject. Operator transfer is a time-bounded proposal that only the exact recipient
subject can accept, with revision-checked cancel and expiry cleanup and idempotent private receipts.
The OIDC issuer and audience are immutable after bootstrap. Signing-key or provider maintenance
must preserve both exact values. Any issuer or audience change requires a separately reviewed
offline identity migration, a complete connection drain, recovery rehearsal, and a new module
artifact; there is no online reducer or proof-session exception. The connection-initialization
reducer checks the immutable policy before public views or ordinary reducers become available.
Service principals, grants, and trusted tools use the same operator guard, receipts, and private
audit trail.
Module updates only provision a truly empty database,
backfill an unambiguous consumed legacy bootstrap, or accept a consistent current state. Partial or
conflicting authority state aborts the update. For local or CI schema smoke tests, use synthetic
issuer, audience, and subject values; never reuse those artifacts for a real publish.

The local integration suite runs a real discovery/JWKS signer against standalone SpacetimeDB and
exercises reducer, SQL, and WebSocket authentication with valid and invalid signed tokens. Provider
selection and the equivalent real-provider cutover remain production launch gates: register the
exact callback/audience, verify bootstrap and operator transfer, and rehearse signing-key rotation
and rollback without changing the issuer or audience.

## Verify and build

```bash
scripts/install-spacetime-cli.sh
cd spacetimedb
cargo fmt --check
cargo check --locked --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --no-default-features
cd ..
pnpm db:generate
pnpm test:spacetimedb
pnpm test:spacetimedb:oidc
```

The synthetic binding and smoke scripts remove their publishable WebAssembly artifacts on exit. CI
rebuilds from `Cargo.lock` and regenerates the checked-in browser bindings to detect schema drift.
For an approved production candidate, set the three real values and use the guarded build path:

```bash
pnpm db:build:production -- --confirm-production-build
```

That guard rejects HTTP, reserved example domains, and every known CI/smoke/binding identity. It
builds but does not publish; publication remains a separately reviewed deployment operation.

## Security boundary

- OIDC issuer/audience checks happen at connection initialization, and both values are immutable
  after bootstrap. There is no online authentication-policy rotation surface.
- Membership, role, private-space, revision, lease, authorization-epoch, and service-capability
  checks happen in reducers or caller-aware Views.
- External effects are represented as idempotent outbox work; reducers never call providers.
- Agent tool class and approval requirements come from administrator-managed policy rows, never
  model or worker input. Policies pin the trusted-catalog revision. Disabling or revising a tool
  immediately revokes open matching runs, and every acquisition, reconciliation, and outcome
  boundary rechecks the exact enabled policy, catalog revision, classification, and scope.
- Public bindings omit all private tables.

Publishing, schema migration, and database deletion are deployment operations. They must use the
isolated 2.6.1 staging/production instance and a reviewed backup/rollback plan; never publish this
module to the unrelated SpacetimeDB service already present on the host.
