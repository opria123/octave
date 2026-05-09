# Screenshot Harness

Automated screenshot capture for OCTAVE's documentation site, using [Playwright's Electron driver](https://playwright.dev/docs/api/class-electronapplication).

## What it does

`capture.mjs` launches the **packaged main bundle** (`out/main/index.js`) as an Electron app and captures named screenshots into `docs/public/screenshots/`. The docs site references those images at `/screenshots/<name>.png`.

## Run

```bash
# 1. Build the app (writes out/main/index.js)
npm run build

# 2. Install Playwright (first run only)
npm install

# 3. Capture screenshots
npm run docs:screenshots
```

Screenshots land in `docs/public/screenshots/`. Re-run any time the UI changes.

## Adding a screenshot

Open `capture.mjs` and add a step to the `STEPS` array:

```js
{
  name: 'my-new-shot',
  description: 'What is being captured',
  run: async (page, app) => {
    // navigate / interact / wait for state
    await page.click('text=Some Button')
    await page.waitForSelector('.some-result')
  }
}
```

Each step:
1. Runs after the previous step (the harness shares one app instance for speed).
2. Has a unique `name` — used as the output filename `<name>.png`.
3. Receives the active `page` (BrowserWindow) and the Electron `app` handle.

## Headless / CI

The harness runs in a real Electron window, so it needs a display. On Linux CI, wrap the script with `xvfb-run`:

```bash
xvfb-run -a npm run docs:screenshots
```

## Loaded-project screenshots

For shots that need a real song loaded (MIDI editor, chart preview, etc.), drop a fixture project at `scripts/screenshots/fixtures/` and have the relevant step set:

```js
process.env.OCTAVE_LOAD_FOLDER_AT_STARTUP = path.resolve('scripts/screenshots/fixtures/sample-song')
```

before launching, then `await page.waitForSelector('.midi-editor')` once it loads.

> The fixture folder is not committed — keep your own seed project locally and run the harness there.
