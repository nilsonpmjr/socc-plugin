# SOCC_MASTER_KEY Rotation Runbook

`SOCC_MASTER_KEY` encrypts provider credentials in MongoDB with libsodium
secretbox. Rotating it requires an offline re-encrypt pass over
`socc_credentials`, then a restart with the new key.

This is a manual break-glass procedure until the planned in-band rotation
endpoint exists.

## Preconditions

- Schedule a short maintenance window.
- Stop new SOC Copilot traffic before the write pass.
- Have shell access to the plugin environment and MongoDB.
- Keep both old and new keys out of shell history where possible.

Generate the new key:

```bash
openssl rand -hex 32
```

## Backup

Create a Mongo backup before touching ciphertext:

```bash
docker compose exec socc-mongo mongodump \
  --db "${MONGO_DB:-socc_plugin}" \
  --archive=/tmp/socc-plugin-before-key-rotation.archive

docker compose cp \
  socc-mongo:/tmp/socc-plugin-before-key-rotation.archive \
  ./socc-plugin-before-key-rotation.archive
```

Keep the backup encrypted at rest. It contains encrypted credentials, and it is
only useful with the old `SOCC_MASTER_KEY`.

## Dry Run

Run the decrypt-only check first. It verifies that every credential document can
be opened with the old key and does not write anything.

```bash
export MONGO_URI='mongodb://socc-mongo:27017'
export MONGO_DB='socc_plugin'
export OLD_SOCC_MASTER_KEY='<current 64-char hex key>'
export NEW_SOCC_MASTER_KEY='<new 64-char hex key>'

bun run rotate:master-key
```

Expected output:

```text
dry-run ok: N credential document(s) decrypt with OLD_SOCC_MASTER_KEY
set CONFIRM_ROTATE_SOCC_MASTER_KEY=rotate to write re-encrypted blobs
```

If dry-run fails, stop. The current key, target database, or stored ciphertext is
not what the script expects.

## Write Pass

Stop the plugin container so no requests decrypt credentials during the write:

```bash
docker compose stop socc-plugin
```

Run the re-encrypt pass:

```bash
CONFIRM_ROTATE_SOCC_MASTER_KEY=rotate bun run rotate:master-key
```

Update the deployed secret/env value to `NEW_SOCC_MASTER_KEY`, then restart:

```bash
docker compose up -d socc-plugin
```

## Verification

Check health:

```bash
curl -fsS http://127.0.0.1:7070/v1/health
```

Then verify at least one credential test through Vantage or the plugin API. The
response should be `ok: true` for a valid provider credential.

## Rollback

If verification fails:

1. Stop `socc-plugin`.
2. Restore the Mongo backup created before rotation.
3. Restore the old `SOCC_MASTER_KEY` secret/env value.
4. Start `socc-plugin`.
5. Re-run `/v1/health` and one credential test.

Do not run the write pass a second time unless you have confirmed which key the
database is currently encrypted with.
