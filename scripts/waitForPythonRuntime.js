// Ensures a bundled-Python-runtime GitHub Release exists for the current
// requirements hash before the main release build proceeds.
//
// Steps:
//   1. Compute the expected release tag.
//   2. If the release already exists → exit 0 (downstream download will succeed).
//   3. Otherwise, look for an in-progress run of python-runtime.yml; if found,
//      wait for it to finish.
//   4. If none is in progress, trigger python-runtime.yml via workflow_dispatch
//      and wait for it to finish.
//   5. Re-verify the release now exists; exit non-zero if not.
//
// Required env:
//   GITHUB_TOKEN, GITHUB_REPOSITORY (auto-set in Actions)

const https = require('https')
const { getReleaseTag } = require('./bundledPythonHash')

const repository = process.env.GITHUB_REPOSITORY || 'opria123/octave'
const token = process.env.GITHUB_TOKEN
const workflowFile = 'python-runtime.yml'
const ref = process.env.GITHUB_REF_NAME || 'master'

const POLL_INTERVAL_MS = 30_000
const MAX_WAIT_MS = 90 * 60 * 1000 // 90 minutes

if (!token) {
  console.error('GITHUB_TOKEN is required')
  process.exit(1)
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'User-Agent': 'octave-runtime-gate',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`
    }
    if (data) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(data)
    }
    const req = https.request(`https://api.github.com${path}`, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const text = buf.toString('utf-8')
        let json = null
        if (text) {
          try { json = JSON.parse(text) } catch { /* non-JSON ok */ }
        }
        resolve({ statusCode: res.statusCode, body: json, raw: text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function releaseExists(tag) {
  const res = await api('GET', `/repos/${repository}/releases/tags/${tag}`)
  return res.statusCode === 200
}

async function findInProgressRun() {
  const res = await api('GET', `/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=20`)
  if (res.statusCode !== 200 || !res.body || !res.body.workflow_runs) return null
  return res.body.workflow_runs.find((r) => r.status === 'queued' || r.status === 'in_progress') || null
}

async function dispatchWorkflow() {
  const res = await api('POST', `/repos/${repository}/actions/workflows/${workflowFile}/dispatches`, {
    ref
  })
  if (res.statusCode !== 204) {
    throw new Error(`workflow_dispatch failed: ${res.statusCode} ${res.raw}`)
  }
}

async function waitForRun(runId) {
  const start = Date.now()
  while (Date.now() - start < MAX_WAIT_MS) {
    const res = await api('GET', `/repos/${repository}/actions/runs/${runId}`)
    if (res.statusCode === 200 && res.body) {
      const { status, conclusion, html_url } = res.body
      if (status === 'completed') {
        console.log(`  • python-runtime.yml run completed: ${conclusion} (${html_url})`)
        return conclusion === 'success'
      }
      console.log(`  • waiting on python-runtime.yml run ${runId}: status=${status}`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS / 60000}min waiting for run ${runId}`)
}

async function findLatestRunSince(timestamp) {
  // After dispatch, poll for the new run to appear.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await api('GET', `/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=20&event=workflow_dispatch`)
    if (res.statusCode === 200 && res.body && res.body.workflow_runs) {
      const recent = res.body.workflow_runs.find((r) => new Date(r.created_at).getTime() >= timestamp - 5000)
      if (recent) return recent
    }
  }
  return null
}

async function main() {
  const tag = getReleaseTag()
  console.log(`  • required runtime release tag: ${tag}`)

  if (await releaseExists(tag)) {
    console.log(`  ✓ release ${tag} already exists`)
    return
  }

  console.log(`  • release ${tag} not found; checking for in-progress build...`)
  let run = await findInProgressRun()

  if (!run) {
    console.log(`  • no in-progress run; dispatching python-runtime.yml on ref=${ref}`)
    const dispatchTime = Date.now()
    await dispatchWorkflow()
    run = await findLatestRunSince(dispatchTime)
    if (!run) throw new Error('Dispatched workflow but could not find its run id')
  }

  console.log(`  • waiting for run ${run.id} (${run.html_url})`)
  const ok = await waitForRun(run.id)
  if (!ok) throw new Error('python-runtime.yml run did not succeed')

  if (!(await releaseExists(tag))) {
    throw new Error(`Run finished but release ${tag} still not present`)
  }
  console.log(`  ✓ release ${tag} is now available`)
}

main().catch((err) => {
  console.error(`runtime gate failed: ${err.message}`)
  process.exit(1)
})
