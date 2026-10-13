# T3 compatibility evidence

This document separates current Go checks from historical validation of the
retired TypeScript implementation. Run the current Go checks from the
repository root with `go test ./...` and `go vet ./...`.

The importer supports database migrations 40–53 explicitly. A supported number
must also pass integrity and required-column checks. This is not a promise that
every future T3 commit retaining the same migration number will remain compatible.

## Pinned references

Each historical reference below has the stated migration as its latest migration.
These references identify the historical schema snapshots used by the former
compatibility harness.

| Migration | Reference commit | Migration change |
|---|---|---|
| 40 | `076e9048dc57` | Project favicon path |
| 41 | `11f051373e79` | Auth session client connection |
| 42 | `3c75eb1132bb` | Thread-linked pull request |
| 43 | `3b86ef941c21` | Unsettled thread timestamp |
| 44 | `5392c9bb99c4` | Clear automatic project model defaults |
| 45 | `ba3cb0773859` | Project auto-pull |
| 46 | `2971ec3209d7` | Repair automatic settlement timestamps |
| 47 | `f6c04c552c20` | Project icons |
| 48 | `223ff4490f76` | Branch pull request |
| 49 | `2d645df474f0` | Active thread ordering |
| 50 | `b7b3ef1e6fcb` | Multiple thread pull requests |
| 51 | `4fed6cfb3517` | Message context |
| 52 | `719a76ca1dbf` | Thread title state (stable v0.0.42) |
| 53 | `adcd90858c3b` | Pull request files viewed (nightly 20260920.2031) |

The migration-50 reference is nightly `v0.0.41-nightly.20260910.1473`.
The migration-52 reference is stable `v0.0.42`; migration 53 is nightly
`v0.0.43-nightly.20260920.2031`. References 40–49 use Effect
`4.0.0-beta.103`, references 50–52 use `4.0.0-rc.112`, and reference 53 uses
`4.0.0-rc.115`.

## Compatibility findings

- The importer-facing event payloads and provider binding fields work across all
  fourteen references, so they use one shared writer. Additional project metadata
  in newer contracts is optional. T3 remains responsible for projection defaults
  and migration repairs; the importer does not write projection rows.
- Bootstrap processes projectors independently. A turn projector can see the
  session projector's final state while replaying older messages. Imported turns
  therefore emit their terminal session event before their assistant messages.
  This preserves interrupted/error turn states and terminal timestamps without
  inventing checkpoint events or leaving messages marked as streaming. Event IDs,
  original content timestamps, and the number of emitted events remain stable.
- Checkpoint recovery recognizes both the older settlement-last layout and the
  new layout. Newly written/recovered ledger entries record the actual database
  migration. Upgrading T3 does not rewrite existing ledger entries or event IDs.
- The migration-50 reference adds `projection.attachment-cleanup`, a bootstrap-only
  maintenance cursor. Backlog checks exclude that cursor but still require the
  read-model projectors to catch up. A database containing only the maintenance
  cursor is still considered unprojected when it has events.
- Migrations 51 and 52 add nullable message-context and title-state columns.
  Their event fields are optional, so existing imported events retain their
  meaning without adding synthetic context or title metadata. Migration 53 adds
  independent pull-request file-view tracking. The shared event writer and
  provider bindings pass the same checks on stable 0.0.42 and the pinned nightly.

## Current Go legacy-schema coverage

`internal/target/legacy/testdata/t3-schemas.json` contains the portable DDL and
migration records for the fourteen T3 reference schemas at migrations 40–53.
`TestLegacyOperationsAgainstHistoricalT3Schemas` constructs each schema in a
temporary SQLite database, validates the profile, and exercises import, repeat
preview, sync, exact sync adoption, and replacement. It also verifies that
those writes leave T3's schema objects and migration records unchanged.

This proves the Go legacy adapter against the captured schema snapshots. It is
not a full T3 server projection or desktop acceptance run. The Go v2 tests use
synthetic pinned-profile homes; see the [v2 acceptance record](t3-v2-acceptance.md)
for the remaining boundary.

## Scope of the historical results

The former 54-scenario harness covered both providers at each of migrations 40–53,
plus upgrades from every migration 40–52 to migration 53. It exercised migration
execution, event decoding and projection, provider binding, idempotent
import/sync/replace, recovery, attachments, activities, terminal states, resume
routing, and continuation adoption against synthetic data and controlled provider
adapters. Those results validated the former TypeScript implementation only.

The former TypeScript harness results do not transfer to the Go implementation.
