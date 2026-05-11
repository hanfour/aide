import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedCredential = Sealed
export type CredentialCipherVersion = 1 | 2
export const CURRENT_CREDENTIAL_CIPHER_VERSION: CredentialCipherVersion = 2

const CREDENTIAL_INFO_V1 = Buffer.from('aide-gateway-credential-v1', 'utf8')
const CREDENTIAL_INFO_V2 = Buffer.from('caliber-gateway-credential-v2', 'utf8')

function credentialInfo(version: CredentialCipherVersion): Buffer {
  return version === 2 ? CREDENTIAL_INFO_V2 : CREDENTIAL_INFO_V1
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
  version: CredentialCipherVersion
}

export function encryptCredential(input: EncryptInput): SealedCredential & { version: 2 } {
  const sealed = encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: CREDENTIAL_INFO_V2,
    salt: input.accountId,
    plaintext: input.plaintext,
  })
  return { ...sealed, version: 2 }
}

export function decryptCredential(input: DecryptInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: credentialInfo(input.version),
    salt: input.accountId,
    sealed: input.sealed,
  })
}
