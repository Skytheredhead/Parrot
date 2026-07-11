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

By default the isolated project is destroyed after the health check. Only after Compose reports no
remaining drill containers and the isolated root has been removed is an integrity-checked success
marker retained under `backups/restore-drills`. The marker binds the exact archive, backup
manifest, source image, candidate restore image, project, and environment; it is also signed by the
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

The automated marker proves only that the exact root passed checksum/extraction and that pinned SpacetimeDB reached its configured health check. Before launch, manually test module load, domain invariants/row counts, tenant/private-space authorization, audit continuity, WSS reconnect, login/read/write, object checksums, search rebuild/deletion, worker idempotency, and notification suppression. Record measured data-loss window and restore duration. Only that full drill can demonstrate RPO/RTO.

Before an image upgrade, repeat the drill with `--image registry/path@sha256:<candidate-digest>`. The marker records the tested image, and the upgrade script refuses evidence from a different image.

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
