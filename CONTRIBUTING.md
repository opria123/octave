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

| Directory | Purpose |
|-----------|---------|
| `src/main/` | Electron main process (IPC handlers, file I/O) |
| `src/preload/` | IPC bridge between main and renderer |
| `src/renderer/src/components/` | React UI components |
| `src/renderer/src/components/chartPreviewModules/` | 3D highway scene (Three.js) |
| `src/renderer/src/stores/` | Zustand state stores |
| `src/renderer/src/services/` | Audio playback, tick/time conversion |
| `src/renderer/src/utils/` | MIDI/chart parsers |
| `src/renderer/src/types/` | Shared TypeScript types and constants |

## Reporting Bugs

- Use the [bug report template](https://github.com/opria123/octave/issues/new?template=bug_report.md)
- Include steps to reproduce, expected vs actual behavior
- Attach the problematic `.mid` or `.chart` file if relevant

## Feature Requests

- Use the [feature request template](https://github.com/opria123/octave/issues/new?template=feature_request.md)
- Describe the use case, not just the solution

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
