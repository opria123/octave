import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import DownloadButton from './components/DownloadButton.vue'
import './custom.css'

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DownloadButton', DownloadButton)
  }
}

export default theme
