import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function toBase62(buf: Buffer): string {
  let out = ''
  let n = BigInt('0x' + buf.toString('hex'))
  const base = BigInt(62)
  while (n > 0n) {
    out = BASE62[Number(n % base)] + out
    n = n / base
  }
  return out || 'A'
}

export function generateApiKey(): { raw: string; prefix: string } {
  // randomBytes(48) = 384 bits → ~64 base62 chars; padStart(61) ensures total >= 64 (3 + 61)
  const randomPart = toBase62(randomBytes(48)).padStart(61, 'A')
  const raw = `ak_${randomPart}`
  return { raw, prefix: raw.slice(0, 8) }
}

export function hashApiKey(pepperHex: string, raw: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error('pepper must be 32 bytes hex (64 chars)')
  }
  return createHmac('sha256', Buffer.from(pepperHex, 'hex')).update(raw).digest('hex')
}

export function verifyApiKey(pepperHex: string, raw: string, storedHashHex: string): boolean {
  const candidate = Buffer.from(hashApiKey(pepperHex, raw), 'hex')
  const stored = Buffer.from(storedHashHex, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}
