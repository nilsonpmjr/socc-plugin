#!/usr/bin/env bun
import sodium from 'libsodium-wrappers'
import { Binary, MongoClient, type Db } from 'mongodb'

const MASTER_KEY_BYTES = 32

type RotationCredentialDoc = {
  _id: string
  ciphertext: unknown
  nonce: unknown
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseHexKey(name: string): Uint8Array {
  const value = requiredEnv(name)
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character hex string`)
  }
  const key = Buffer.from(value, 'hex')
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`${name} must decode to ${MASTER_KEY_BYTES} bytes`)
  }
  return new Uint8Array(key)
}

function asUint8Array(value: unknown, field: string): Uint8Array {
  if (value instanceof Binary) return new Uint8Array(value.buffer)
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  throw new Error(`credential has invalid ${field}`)
}

function isWriteEnabled(): boolean {
  return process.env.CONFIRM_ROTATE_SOCC_MASTER_KEY === 'rotate'
}

async function main(): Promise<void> {
  await sodium.ready

  const mongoUri = requiredEnv('MONGO_URI')
  const mongoDb = process.env.MONGO_DB?.trim() || 'socc_plugin'
  const oldKey = parseHexKey('OLD_SOCC_MASTER_KEY')
  const newKey = parseHexKey('NEW_SOCC_MASTER_KEY')
  const write = isWriteEnabled()

  if (Buffer.compare(Buffer.from(oldKey), Buffer.from(newKey)) === 0) {
    throw new Error('OLD_SOCC_MASTER_KEY and NEW_SOCC_MASTER_KEY must differ')
  }

  const client = new MongoClient(mongoUri)
  await client.connect()
  try {
    const db: Db = client.db(mongoDb)
    const col = db.collection<RotationCredentialDoc>('socc_credentials')
    const docs = await col
      .find(
        { ciphertext: { $exists: true }, nonce: { $exists: true } },
        { projection: { _id: 1, ciphertext: 1, nonce: 1 } },
      )
      .toArray()

    let checked = 0
    const updates: Array<{
      updateOne: {
        filter: { _id: string }
        update: { $set: { ciphertext: Binary; nonce: Binary } }
      }
    }> = []

    for (const doc of docs) {
      const ciphertext = asUint8Array(doc.ciphertext, 'ciphertext')
      const nonce = asUint8Array(doc.nonce, 'nonce')
      const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, oldKey)
      const nextNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
      const nextCiphertext = sodium.crypto_secretbox_easy(plaintext, nextNonce, newKey)
      checked++

      if (write) {
        updates.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                ciphertext: new Binary(nextCiphertext),
                nonce: new Binary(nextNonce),
              },
            },
          },
        })
      }
    }

    if (!write) {
      console.log(
        `dry-run ok: ${checked} credential document(s) decrypt with OLD_SOCC_MASTER_KEY`,
      )
      console.log('set CONFIRM_ROTATE_SOCC_MASTER_KEY=rotate to write re-encrypted blobs')
      return
    }

    if (updates.length > 0) {
      await col.bulkWrite(updates, { ordered: true })
    }
    console.log(`rotated ${updates.length} credential document(s) to NEW_SOCC_MASTER_KEY`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(`master key rotation failed: ${(err as Error).message}`)
  process.exit(1)
})
