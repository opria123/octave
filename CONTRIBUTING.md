# Contributing to OCTAVE

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/opria123/octave.git
cd octave
npm install
npm run dev
```

**Requirements:** Node.js 18+, npm

## Making Changes

1. Fork the repository and create a branch from `master`
2. Make your changes
3. Run `npm run typecheck` and `npm run lint` to verify
4. Commit with a descriptive message using [conventional commits](https://www.conventionalcommits.org/):
   - `feat: add pro keys velocity editing` — new feature (bumps minor version)
   - `fix: correct sustain threshold for .chart files` — bug fix (bumps patch version)
   - `refactor:`, `docs:`, `chore:` — non-release changes
5. Open a pull request against `master`

## Code Style

- **TypeScript** throughout — no `any` unless truly unavoidable
- **Prettier** handles formatting (`npm run format`)
- **ESLint** catches common issues (`npm run lint`)
- Use existing patterns in the codebase as a reference

## Project Structure

| Directory                                          | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `src/main/`                                        | Electron main process (IPC handlers, file I/O) |
| `src/preload/`                                     | IPC bridge between main and renderer           |
| `src/renderer/src/components/`                     | React UI components                            |
| `src/renderer/src/components/chartPreviewModules/` | 3D highway scene (Three.js)                    |
| `src/renderer/src/stores/`                         | Zustand state stores                           |
| `src/renderer/src/services/`                       | Audio playback, tick/time conversion           |
| `src/renderer/src/utils/`                          | MIDI/chart parsers                             |
| `src/renderer/src/types/`                          | Shared TypeScript types and constants          |

## Reporting Bugs

- Use the [bug report template](https://github.com/opria123/octave/issues/new?template=bug_report.md)
- Include steps to reproduce, expected vs actual behavior
- Attach the problematic `.mid` or `.chart` file if relevant

## Feature Requests

- Use the [feature request template](https://github.com/opria123/octave/issues/new?template=feature_request.md)
- Describe the use case, not just the solution

## Releases & Beta Testing

OCTAVE ships through two automated channels. Both build Windows, macOS, and
Linux installers and publish a GitHub Release; users auto-update via
electron-updater.

| Channel | Branch   | Workflow                                                 | Release type                  | Who receives it       |
| ------- | -------- | -------------------------------------------------------- | ----------------------------- | --------------------- |
| Stable  | `master` | [`release.yml`](.github/workflows/release.yml)           | normal release (`vX.Y.Z`)     | everyone              |
| Beta    | `beta`   | [`release-beta.yml`](.github/workflows/release-beta.yml) | pre-release (`vX.Y.Z-beta.N`) | only users who opt in |

### How users opt into beta

In the app: **Settings → Updates → "Receive beta (pre-release) updates"**.
This flips `autoUpdater.allowPrerelease`, so the user's app starts picking up
pre-release builds and auto-updating to them. Turning it back off returns them
to the stable channel. Because `1.2.3-beta.2` sorts _below_ `1.2.3` in semver,
beta testers automatically roll forward onto the matching stable release once
it ships — no manual reinstall.

> The opt-in toggle itself lives in the app, so a user can only reach it once
> they are on a stable build that already contains it. When introducing the
> beta channel for the first time, the toggle must go out in a **stable**
> (`master`) release first; only then can existing users opt in to test
> subsequent `beta` builds.

### Typical fix-verification flow

1. Land the fix on the `beta` branch (`git push origin beta`).
2. The beta workflow auto-versions `vX.Y.Z-beta.N`, builds all platforms, and
   publishes a GitHub **pre-release**.
3. Affected users enable the beta toggle (or download the pre-release installer
   from the Releases page) and confirm the fix.
4. Once verified, merge `beta` → `master`. The stable workflow cuts the normal
   `vX.Y.Z` release and every user updates to it.

Both workflows version automatically from conventional-commit messages
(`feat:` bumps minor, `fix:`/others bump patch, `!:`/`BREAKING CHANGE` bumps
major), so no manual version edits are needed.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
