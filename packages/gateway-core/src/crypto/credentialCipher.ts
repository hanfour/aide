import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

export interface SealedCredential {
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

interface EncryptInput {
  masterKeyHex: string
  accountId: string
  plaintext: string
}

interface DecryptInput {
  masterKeyHex: string
  accountId: string
  sealed: SealedCredential
}

const INFO = Buffer.from('aide-gateway-credential-v1', 'utf8')

function deriveKey(masterKeyHex: string, accountId: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error('masterKey must be 32 bytes hex (64 chars)')
  }
  const master = Buffer.from(masterKeyHex, 'hex')
  const salt = Buffer.from(accountId, 'utf8')
  return Buffer.from(hkdfSync('sha256', master, salt, INFO, 32))
}

export function encryptCredential(input: EncryptInput): SealedCredential {
  const key = deriveKey(input.masterKeyHex, input.accountId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { nonce, ciphertext, authTag }
}

export function decryptCredential(input: DecryptInput): string {
  const key = deriveKey(input.masterKeyHex, input.accountId)
  const decipher = createDecipheriv('aes-256-gcm', key, input.sealed.nonce)
  decipher.setAuthTag(input.sealed.authTag)
  const plain = Buffer.concat([decipher.update(input.sealed.ciphertext), decipher.final()])
  return plain.toString('utf8')
}
