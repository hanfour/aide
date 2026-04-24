import { encryptAesGcm, decryptAesGcm, type Sealed } from './aesGcmHkdf.js'

export type SealedBody = Sealed

interface EncryptBodyInput {
  masterKeyHex: string
  requestId: string
  plaintext: string
}

interface DecryptBodyInput {
  masterKeyHex: string
  requestId: string
  sealed: SealedBody
}

const BODY_INFO = Buffer.from('aide-gateway-body-v1', 'utf8')

export function encryptBodyRaw(input: EncryptBodyInput): SealedBody {
  return encryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO,
    salt: input.requestId,
    plaintext: input.plaintext,
  })
}

export function decryptBodyRaw(input: DecryptBodyInput): string {
  return decryptAesGcm({
    masterKeyHex: input.masterKeyHex,
    info: BODY_INFO,
    salt: input.requestId,
    sealed: input.sealed,
  })
}
