import { describe, expect, it } from 'vitest'
import { sanitizeTrainingSchemaValues } from './trainingSchema'

const schema = {
  type: 'object',
  required: ['epochs'],
  properties: {
    epochs: { type: 'integer', minimum: 1, maximum: 500, default: 20 },
    device: { type: 'string', enum: ['auto', 'cuda', 'cpu'], default: 'auto' },
    augment: { type: 'boolean', default: false },
    run_name: { type: 'string' }
  }
} as const

describe('sanitizeTrainingSchemaValues', () => {
  it('uses STRUM defaults and strips undeclared renderer values', () => {
    expect(
      sanitizeTrainingSchemaValues(schema, { epochs: 24, arbitrary: 'discard me' }, 'train')
    ).toEqual({
      epochs: 24,
      device: 'auto',
      augment: false
    })
  })

  it.each([
    [{ epochs: 0 }, 'out-of-range'],
    [{ epochs: 1.5 }, 'invalid'],
    [{ epochs: 4, device: 'mps' }, 'unsupported']
  ])('rejects malformed values (%s)', (values, message) => {
    expect(() => sanitizeTrainingSchemaValues(schema, values, 'train')).toThrow(message)
  })

  it('requires schema fields without defaults', () => {
    expect(() =>
      sanitizeTrainingSchemaValues(
        { type: 'object', required: ['run_name'], properties: { run_name: { type: 'string' } } },
        {},
        'train'
      )
    ).toThrow('requires')
  })
})
