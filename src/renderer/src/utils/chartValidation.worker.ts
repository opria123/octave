import { validateChart } from './chartValidation'

self.onmessage = (event) => {
  const { song, settings } = event.data
  try {
    const issues = validateChart(song, settings)
    self.postMessage({ type: 'success', issues })
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    self.postMessage({ type: 'error', error: errMsg })
  }
}
