import { describe, expect, it } from 'vitest'
import { resolveTorchDevice } from './device'

describe('resolveTorchDevice', () => {
  it('prefers CUDA when available', () => {
    const device = resolveTorchDevice({
      cuda: { is_available: () => true },
      backends: { mps: { is_available: () => true } }
    })

    expect(device).toBe('cuda')
  })

  it('falls back to MPS when CUDA is unavailable', () => {
    const device = resolveTorchDevice({
      cuda: { is_available: () => false },
      backends: { mps: { is_available: () => true } }
    })

    expect(device).toBe('mps')
  })

  it('falls back to CPU when neither accelerator is available', () => {
    const device = resolveTorchDevice({
      cuda: { is_available: () => false },
      backends: { mps: { is_available: () => false } }
    })

    expect(device).toBe('cpu')
  })

  it('falls back to CPU when probes throw', () => {
    const device = resolveTorchDevice({
      cuda: { is_available: () => { throw new Error('cuda unavailable') } },
      backends: { mps: { is_available: () => { throw new Error('mps unavailable') } } }
    })

    expect(device).toBe('cpu')
  })
})