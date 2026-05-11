import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedBody = Sealed
export type BodyCipherVersion = 1 | 2
export const CURRENT_BODY_CIPHER_VERSION: BodyCipherVersion = 2

const BODY_INFO_V1 = Buffer.from('aide-gateway-body-v1', 'utf8')
const BODY_INFO_V2 = Buffer.from('caliber-gateway-body-v2', 'utf8')

function bodyInfo(version: BodyCipherVersion): Buffer {
  return version === 2 ? BODY_INFO_V2 : BODY_INFO_V1
}

interface EncryptBodyInput {
  masterKeyHex: string
  requestId: string
  plaintext: string
}

interface DecryptBodyInput {
  masterKeyHex: string
  requestId: string
  sealed: SealedBody
  version: BodyCipherVersion
}

export function encryptBodyRaw(input: EncryptBodyInput): SealedBody & { version: 2 } {
  const sealed = encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO_V2,
    salt: input.requestId,
    plaintext: input.plaintext,
  })
  return { ...sealed, version: 2 }
}

export function decryptBodyRaw(input: DecryptBodyInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: bodyInfo(input.version),
    salt: input.requestId,
    sealed: input.sealed,
  })
}
