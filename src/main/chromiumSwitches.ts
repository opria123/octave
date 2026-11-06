/**
 * Chromium command-line switches OCTAVE applies at startup, keyed by the
 * platform they are needed on. Kept as plain data so the decision is unit
 * testable without booting Electron.
 */
export interface ChromiumSwitch {
  name: string
  value?: string
}

export function chromiumSwitchesFor(platform: NodeJS.Platform): ChromiumSwitch[] {
  const switches: ChromiumSwitch[] = [
    // Allow AudioContext to start without a user gesture.
    { name: 'autoplay-policy', value: 'no-user-gesture-required' }
  ]

  if (platform === 'win32') {
    // Windows GPU drivers can be told to post-process every frame an app
    // presents (NVIDIA Control Panel "FXAA", AMD "Morphological filtering").
    // Chromium normally redraws only the damaged part of the window and keeps
    // the previously presented pixels for everything else, so the driver's
    // filter runs again on the same pixels frame after frame. Anything that is
    // not being repainted (i.e. everything except what the mouse is hovering)
    // gets progressively blurrier, which is issue #80. Forcing a full redraw
    // on every frame limits the filter to a single pass, the same thing
    // Chrome/VS Code users get by excluding the exe in the driver settings.
    switches.push({ name: 'ui-disable-partial-swap' })
  }

  return switches
}
