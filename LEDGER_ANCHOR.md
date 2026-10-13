# Ledger anchor

Verdict's decision ledger is hash-chained: each entry's hash is the SHA-256 of
`prev_hash|kind|ref_id|payload|at`, starting from a `GENESIS` value. The chain
was enabled partway through the prototype's life, so entries from **seq 92**
onward carry hashes; earlier entries predate the chain and have none.

A hash chain inside a database only proves internal consistency — anyone with
database write access could rewrite the rows and recompute every hash. This
file anchors the chain externally: the tip hash below is committed to this
public repository, so the ledger's history up to that entry can be verified
against a value the database operator cannot quietly change.

## Anchored tip (2026-10-13)

- **seq**: 146
- **hash**: `b6b6e9e6d03cc12b76aa2ad43516192ad6b8e4c910dbd8b120b55b34bca38bbf`

## How to verify

1. Fetch the ledger from the live API: `GET https://verdict.hey-demo-827.workers.dev/api/ledger`
2. Starting from seq 92 (`prev_hash` = `GENESIS`), recompute each entry's hash as
   `SHA-256(prev_hash|kind|ref_id|payload|at)` and confirm it matches the stored
   `hash` and that each `prev_hash` equals the previous entry's `hash`.
3. Confirm the recomputed hash at seq 146 equals the anchored hash above.
   Entries after seq 146 chain forward from this anchor.
