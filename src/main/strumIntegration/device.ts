import type { StrumDevice } from './types'

type TorchLike = {
  cuda?: {
    is_available?: () => boolean
  }
  backends?: {
    mps?: {
      is_available?: () => boolean
    }
  }
}

function safeProbe(probe: (() => boolean) | undefined): boolean {
  if (!probe) return false

  try {
    return probe() === true
  } catch {
    return false
  }
}

export function resolveTorchDevice(torchModule: TorchLike): StrumDevice {
  if (safeProbe(torchModule.cuda?.is_available)) {
    return 'cuda'
  }

  if (safeProbe(torchModule.backends?.mps?.is_available)) {
    return 'mps'
  }

  return 'cpu'
}
