Bundled Python runtime staging area for packaged STRUM support.

`npm run prepare:python-runtime` copies the build machine's Python 3.11+ runtime,
installs the STRUM Python dependencies, and stages the result here under the
current platform and architecture.

Expected layout after staging:

- win32-x64/metadata.json
- win32-x64/python/...
- win32-arm64/metadata.json
- win32-arm64/python/...
- darwin-x64/metadata.json
- darwin-x64/python/...
- darwin-arm64/metadata.json
- darwin-arm64/python/...
- linux-x64/metadata.json
- linux-x64/python/...
- linux-arm64/metadata.json
- linux-arm64/python/...

Packaged OCTAVE builds use only these bundled runtimes.
System Python is allowed in development only.
