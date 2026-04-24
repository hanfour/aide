import { describe, it, expect } from 'vitest'
import { rubrics } from '../../src/schema/rubrics'

describe('rubrics schema', () => {
  it('exports table with definition JSONB + is_default + soft delete', () => {
    const cols = Object.keys(rubrics)
    for (const c of [
      'id', 'orgId', 'name', 'description', 'version',
      'definition', 'isDefault', 'createdBy',
      'createdAt', 'updatedAt', 'deletedAt',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
