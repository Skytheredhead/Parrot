# Backup, restore drill, upgrade, and rollback runbook

Date: 2026-07-11

Public SpacetimeDB documentation does not establish a supported hot-copy procedure for its data root. These artifacts therefore implement only a stopped, complete-root archive for the dedicated Compose instance. Never copy the live root and never apply these commands to the audited unrelated service on port `4789`.

## Cold backup

The dry run names the exact affected service:

```bash
infra/scripts/backup.sh --env-file /protected/path/production.env
```

During an approved maintenance window:

```bash
infra/scripts/backup.sh \
  --env-file /protected/path/production.env \
  --apply \
  --confirm project-conversation-production
```

The script holds the environment-wide operations lock, validates the project and paths, requires the persistent reviewed image pin, verifies the
running image equals that pin, inspects ownership labels and the exact `/stdb` bind, stops only
`project-conversation-production/spacetimedb`, archives the complete root to a `.partial` file,
atomically renames it, writes private SHA-256 and manifest sidecars, restarts only that service, and
waits for health. The manifest binds the archive checksum/name, Compose project, environment, exact
source image, reviewed-pin checksum, and source-root UID/GID/mode. The manifest has its own checksum
sidecar and an Ed25519 signature from the environment's dedicated evidence key. A trap attempts the
same narrow restart if archiving fails. Before stopping, it writes a private checksummed journal and
advances it through stop request, stopped, archive published, restarted, and committed phases. If the
operator process is killed after the database stops, the next explicitly confirmed backup run detects
the incomplete journal, removes only recorded partial artifacts, restores the recorded pinned service,
waits for health, marks the journal recovered, and exits so a fresh backup requires a separate run.

The local archive is not sufficient protection. Copy the archive, checksum, manifest, manifest
checksum, and manifest signature to an approved encrypted offsite/immutable destination under
credentials separate from the production writer. Preserve the reviewed public verification key and
key identifier with the recovery documentation, while recovering the signing key only through the
approved secret manager. Apply approved retention and deletion/legal-hold rules. Do not bundle
secrets with data backups. Search indexes are rebuilt, not treated as authoritative backups. Object
storage needs its own versioned inventory and integrity evidence.

## Isolated restore drill

The restore script accepts only an archive under the configured backup directory, verifies the
archive/manifest checksum chain plus project/environment/image provenance, rejects future mtimes,
path traversal, links, special files, set-id/sticky entries, and world-writable archive entries,
extracts to the private environment-specific parent
`/srv/project-conversation/restore-drills/<production|staging>`, derives a new Compose project, and uses a
reserved loopback port in `39200-39999`. It never stops or mounts the base project.
Without `--image`, the drill uses the exact source image recorded in the validated backup manifest;
candidate-image upgrade drills must pass `--image` explicitly.

The reviewed environment file must also bind `SPACETIMEDB_DATABASE_NAME`, the exact
`SPACETIMEDB_DATABASE_IDENTITY`, `RESTORE_EXPECTED_INITIAL_PROGRAM_HASH`, and
`RESTORE_EXPECTED_MODULE_SCHEMA_SHA256`. Record the database's exact `initial_program` hash as
initialization provenance only; this endpoint does not prove the code installed by a later
republish, so every bounded record explicitly says `current_module_code=NotVerified`. Compute the schema
digest from the approved live module as canonical compact JSON (`curl` the loopback-only
`/v1/database/<name>/schema?version=9` endpoint, then `jq -S -c` and SHA-256 it), review it with the module
release, and never learn or bless it from the restore being tested. Place a database-owner
Spacetime token at `RESTORE_VERIFIER_DATABASE_OWNER_TOKEN_FILE` with mode `0400` or `0600`. It must
be the OIDC token for the identity that owns/published the database and must match the module's
immutable issuer/audience policy; an ordinary application/service token and a host-issued token
rejected by `client_connected` are intentionally insufficient to read private tables. Recover
or mount this credential just in time through the approved secret process, never copy it into the
backup, and remove it after the maintenance workflow.

Dry run:

```bash
infra/scripts/restore-drill.sh \
  --env-file /protected/path/production.env \
  --archive /srv/project-conversation/production/backups/spacetimedb-production-TIMESTAMP.tar.gz
```

Explicit drill:

```bash
infra/scripts/restore-drill.sh \
  --env-file /protected/path/production.env \
  --archive /srv/project-conversation/production/backups/spacetimedb-production-TIMESTAMP.tar.gz \
  --apply \
  --confirm project-conversation-production
```

After health, the script runs a no-egress verifier against only `http://127.0.0.1:<reserved-port>`.
It matches the database identity, initialization provenance, and canonical schema digest, proves database-owner access to all 61
required private tables with aggregate-only queries, compares 65 bounded child/parent counts, and
verifies audit-to-workspace referential continuity. SQL responses are private transient files, are
never printed, and are removed before the
verifier exits. Because the audit model has no global sequence or external anchor, the evidence says
`BoundedReferentialOnly`; it does not claim immutability or complete temporal continuity.

By default the isolated project is destroyed after bounded verification. Only after Compose reports no
remaining drill containers and the isolated root has been removed is an integrity-checked success
marker retained under `backups/restore-drills`. The marker binds the exact archive, backup
manifest, source image, candidate restore image, project, environment, database identity, initial
program hash, schema digest, the explicit lack of current-module-code proof, and bounded verification results; it is also signed by the
same environment evidence key. Upgrade verifies both signatures, so recomputing an unkeyed checksum
cannot fabricate drill evidence. If Compose teardown fails,
the script fails and deliberately preserves the restore root; never remove that root until the exact
derived project is confirmed down. `--keep` is an explicit diagnostic option and leaves a
loopback-only drill running for manual inspection; its signed `.kept` marker says teardown was not
performed and is explicitly ineligible for upgrades. A persistent journal and a scan of labeled
containers plus the restore-root parent block later drills when an interrupted or kept drill exists.
The operator must later remove that exact derived project and drill directory.

The drill preserves safe file modes but deliberately remaps ownership to the drill operator rather
than applying archived numeric owners. The original root UID/GID/mode remain in the backup manifest.
This is sufficient only for the isolated container health drill. A production restore requires a
reviewed UID/GID mapping, an operator-owned test showing the restored service can read/write every
required path without broadening permissions, and explicit verification that no set-id, link, device,
or world-writable entry is introduced.

The signed v4 marker is deliberately not a traffic-readiness artifact. It always records
`deletion_lifecycle_overlay=NotConfigured`, `object_inventory=NotConfigured`,
`search_rebuild=NotConfigured`, `provider_checks=NotConfigured`,
`outbox_lease_recovery_shape=NotVerified`, and `traffic_eligible=false`. A public global scan is not
used for restore verification; a future owner-only bounded maintenance snapshot must prove the
outbox lease invariant without creating a cross-tenant workload amplifier.
`upgrade_eligible=false` prevents this bounded evidence from authorizing a live database change.
Before launch, manually test tenant/private-space
authorization, authorization epochs, WSS reconnect, login/read/write, object checksums, search
rebuild and deletion propagation, worker recovery/idempotency, provider suppression, and notification
behavior. Record measured data-loss window and restore duration. Only that full drill can demonstrate
RPO/RTO and traffic readiness.

Before an image upgrade, repeat the drill with `--image registry/path@sha256:<candidate-digest>`.
The bounded marker records the tested image but cannot authorize the upgrade. The upgrade remains
blocked until a future reviewed evidence format proves traffic eligibility as well as the exact
candidate image.

## Image upgrade

An upgrade is image-only; it does not invoke module publication or `spacetime version upgrade`. It
requires a digest-pinned target, a signed backup whose bounded, cross-checked `created_epoch` is less
than 24 hours old, a fully matching backup
manifest, and an integrity-checked success marker linked to that exact manifest/checksum and target
image. The backup source image and pin checksum must equal the currently running reviewed image. It
records the previous/target images and evidence checksums in a checksummed transaction, then advances
the persistent reviewed intent pin, applies the labeled Compose service, verifies the exact image and
health, and commits the phase. Re-running the exact command resumes the recorded phase; a different
transition cannot overwrite incomplete recovery evidence. Freshness never trusts mutable filesystem
mtime. The 24-hour gate applies when creating a new transaction; an exact checksummed incomplete
transaction remains resumable after that window so a maintenance interruption cannot strand an
already-recorded image intent. If process death leaves the target pin written while the journal still
says `prepared`, resume accepts only that transaction's exact image-upgrade reason and transition ID;
an unrelated pin remains fail-closed.

Review the dry plan first, then use an approved maintenance window:

```bash
infra/scripts/upgrade.sh \
  --env-file /protected/path/production.env \
  --image registry.example/spacetime@sha256:EXACT_DIGEST \
  --backup /srv/project-conversation/production/backups/EXACT_ARCHIVE.tar.gz \
  --restore-marker /srv/project-conversation/production/backups/restore-drills/EXACT.success \
  --ack-forward-only \
  --apply \
  --confirm project-conversation-production
```

Before this command, independently verify platform manifest, upstream compatibility, release notes, module/toolchain compatibility, SBOM/scan, disk headroom, monitoring, maintenance ownership, and a rehearsed forward-repair plan. Container health alone is not upgrade success; run the full application verification suite before traffic.

## Image rollback

Rollback changes only the container image recorded before the last upgrade. It first requires the
running image to equal that recorded target and the reviewed pin to match either side of the same
recorded transition, preventing a stale state file from rolling back an unrelated deployment. The
rollback first records a `rollback-prepared` phase, then advances the intent pin and records its exact
checksum before container replacement. If the process dies between the pin transition and its next
journal write, the prepared phase accepts only the transition-specific rollback pin and resumes.
Rollback then progresses through intent, applied, and committed phases, so re-running resumes rather
than guessing. It cannot undo a module publication, schema/data
transformation, commit-log format change, or external provider side effect. Use it only when the
older image is proven compatible with current data/module state; otherwise use rehearsed forward
repair or full restore.

```bash
infra/scripts/rollback.sh \
  --env-file /protected/path/production.env \
  --ack-schema-compatible \
  --apply \
  --confirm project-conversation-production
```

After rollback, repeat end-to-end and recovery checks. Never improvise a data downgrade against the live root.

## Frequency and evidence

Run a full isolated restore before launch, after every database/storage upgrade or material schema change, and at least monthly once approved. Alert on backup age/failure, offsite-copy age/failure, restore-drill age/failure, disk/inode pressure, and restore duration against approved RPO/RTO. Preserve operator, runbook revision, archive/image/module digests, timestamps, measured outcomes, failures, and follow-up owner without recording secrets or user content.

Relevant upstream evidence: [SpacetimeDB self-hosting](https://spacetimedb.com/docs/how-to/deploy/self-hosting/) and the still-open [backup tooling feature request](https://spacetimedb.com/features/requests/50), accessed 2026-07-11.
