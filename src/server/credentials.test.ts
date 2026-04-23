import { describe, expect, test } from 'bun:test'
import sodium from 'libsodium-wrappers'

// Pure-crypto smoke: exercises the exact envelope CredentialsStore uses
// (crypto_secretbox_easy, 24-byte random nonce, 32-byte key). No Mongo
// here — integration coverage lands with the docker-compose smoke test.

const MASTER_KEY_LENGTH = 32

describe('credentials crypto envelope', () => {
  test('round-trips plaintext through sodium.crypto_secretbox_easy', async () => {
    await sodium.ready
    const key = sodium.randombytes_buf(MASTER_KEY_LENGTH)
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const plaintext = 'sk-test-abcdef1234567890'

    const ciphertext = sodium.crypto_secretbox_easy(
      sodium.from_string(plaintext),
      nonce,
      key,
    )
    const recovered = sodium.to_string(
      sodium.crypto_secretbox_open_easy(ciphertext, nonce, key),
    )

    expect(recovered).toBe(plaintext)
    expect(nonce.length).toBe(24)
    expect(key.length).toBe(32)
    expect(ciphertext.length).toBeGreaterThan(plaintext.length) // MAC appended
  })

  test('rejects ciphertext under the wrong key', async () => {
    await sodium.ready
    const keyA = sodium.randombytes_buf(MASTER_KEY_LENGTH)
    const keyB = sodium.randombytes_buf(MASTER_KEY_LENGTH)
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const ct = sodium.crypto_secretbox_easy(
      sodium.from_string('secret'),
      nonce,
      keyA,
    )
    expect(() => sodium.crypto_secretbox_open_easy(ct, nonce, keyB)).toThrow()
  })

  test('rejects tampered ciphertext under the right key (MAC catches it)', async () => {
    await sodium.ready
    const key = sodium.randombytes_buf(MASTER_KEY_LENGTH)
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
    const ct = sodium.crypto_secretbox_easy(
      sodium.from_string('secret'),
      nonce,
      key,
    )
    ct[0] = ct[0]! ^ 0x01
    expect(() => sodium.crypto_secretbox_open_easy(ct, nonce, key)).toThrow()
  })
})
