import { useEffect, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Layout } from './components'
import { SetupModal } from './components/SetupModal'
import { AutosaveProvider, useKeyboardShortcuts } from './hooks'
import { init as initAudio } from './services/audioService'

// Error boundary to prevent white-screen crashes
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled React error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#fff', background: '#1e1e1e', height: '100vh' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#f88' }}>
            {this.state.error?.message}
          </pre>
          <button
            style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

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

  return (
    <>
      <Layout />
      <SetupModal />
    </>
  )
}

function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AutosaveProvider>
        <AppContent />
      </AutosaveProvider>
    </ErrorBoundary>
  )
}

export default App
