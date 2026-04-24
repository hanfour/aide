import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

export interface Sealed {
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export interface EncryptParams {
  masterKeyHex: string
  info: Buffer
  salt: Buffer | string
  plaintext: string
}

export interface DecryptParams {
  masterKeyHex: string
  info: Buffer
  salt: Buffer | string
  sealed: Sealed
}

export function deriveKey(masterKeyHex: string, salt: Buffer | string, info: Buffer): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error('masterKey must be 32 bytes hex (64 chars)')
  }
  const master = Buffer.from(masterKeyHex, 'hex')
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'utf8')
  return Buffer.from(hkdfSync('sha256', master, saltBuf, info, 32))
}

export function encryptAesGcm(params: EncryptParams): Sealed {
  const key = deriveKey(params.masterKeyHex, params.salt, params.info)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(params.plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { nonce, ciphertext, authTag }
}

export function decryptAesGcm(params: DecryptParams): string {
  const key = deriveKey(params.masterKeyHex, params.salt, params.info)
  const decipher = createDecipheriv('aes-256-gcm', key, params.sealed.nonce)
  decipher.setAuthTag(params.sealed.authTag)
  const plain = Buffer.concat([decipher.update(params.sealed.ciphertext), decipher.final()])
  return plain.toString('utf8')
}
