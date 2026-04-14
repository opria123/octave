import { useEffect } from 'react'
import { Layout } from './components'
import { AutosaveProvider, useKeyboardShortcuts } from './hooks'
import { init as initAudio } from './services/audioService'

function AppContent(): React.JSX.Element {
  useKeyboardShortcuts()

  // Resume AudioContext on first user interaction (click/keydown)
  // Required by browser autoplay policy before any audio can play
  useEffect(() => {
    const resume = (): void => {
      initAudio()
      window.removeEventListener('click', resume)
      window.removeEventListener('keydown', resume)
    }
    window.addEventListener('click', resume)
    window.addEventListener('keydown', resume)
    return () => {
      window.removeEventListener('click', resume)
      window.removeEventListener('keydown', resume)
    }
  }, [])

  return <Layout />
}

function App(): React.JSX.Element {
  return (
    <AutosaveProvider>
      <AppContent />
    </AutosaveProvider>
  )
}

export default App
