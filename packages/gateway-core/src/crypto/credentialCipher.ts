import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedCredential = Sealed

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

const CREDENTIAL_INFO = Buffer.from('aide-gateway-credential-v1', 'utf8')

export function encryptCredential(input: EncryptInput): SealedCredential {
  return encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO,
    salt: input.accountId,
    plaintext: input.plaintext,
  })
}

export function decryptCredential(input: DecryptInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO,
    salt: input.accountId,
    sealed: input.sealed,
  })
}
