/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const Module = require('node:module')
const path = require('node:path')

function loadWorkflowContract() {
  const filename = path.resolve('src/lib/github-worker-workflow.ts')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
  return mod.exports
}

function loadOAuth() {
  const filename = path.resolve('src/lib/github-oauth.ts')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => name === './github-worker-workflow' ? loadWorkflowContract() : require(name)
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
  return mod.exports
}

function loadSetup(api) {
  const filename = path.resolve('src/lib/github-worker-setup.ts')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  class GitHubApiError extends Error { constructor(message, status) { super(message); this.status = status } }
  mod.require = (name) => {
    if (name === './github-worker-workflow') return loadWorkflowContract()
    if (name === './github-oauth') return {
      githubApi: api,
      GitHubApiError,
      listGitHubWorkflows: async (token, owner, repo) => {
        const response = await api(`/repos/${owner}/${repo}/actions/workflows?per_page=100`, token)
        return Array.isArray(response.workflows) ? response.workflows : []
      },
    }
    return require(name)
  }
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
  return { ...mod.exports, GitHubApiError }
}
const source = { id: 1, name: 'Drive', full_name: 'iamnadith/Drive', owner: { login: 'iamnadith' }, default_branch: 'main' }
const repo = (id, extra = {}) => ({ id, name: `renamed-${id}`, full_name: `me/renamed-${id}`, owner: { login: 'me' }, default_branch: 'custom', permissions: { admin: true, push: true }, ...extra })
const marker = { encoding: 'base64', content: Buffer.from(fs.readFileSync('.drive-worker.json')).toString('base64') }
const workflow = { type: 'file', encoding: 'base64', content: Buffer.from(fs.readFileSync('.github/workflows/migration-worker.yml')).toString('base64') }
function fixture(repos, options = {}) {
  const calls = []
  let workflowListCalls = 0
  let setup
  const api = async (url, token, init) => {
    calls.push({ url, method: init?.method || 'GET' })
    if (options.fail && options.fail(url)) throw new setup.GitHubApiError('Rate limited', 403)
    if (url === '/repos/iamnadith/Drive') return source
    if (url.startsWith('/user/repos?')) {
      const page = Number(new URL(`https://api.github.com${url}`).searchParams.get('page'))
      return repos.slice((page - 1) * 10, page * 10)
    }
    if (url === '/user') return { login: 'me' }
    if (url === '/repos/me/drive-worker-1' && options.existingFork) return options.existingFork
    if (options.missingFile && url.includes('/contents/migration')) throw new setup.GitHubApiError('Not ready', 404)
    if (url.endsWith('/forks')) return repo(500, { fork: true, source: { id: 1 } })
    if (url.includes('/contents/.drive-worker.json')) {
      if (options.marked?.some(id => url.includes(`/renamed-${id}/`))) return marker
      throw new setup.GitHubApiError('Not found', 404)
    }
    if (url.includes('/contents/')) return /\.ya?ml/.test(url) ? workflow : { type: 'file' }
    if (url.endsWith('/enable')) return {}
    if (url.includes('/actions/workflows?per_page=100')) {
      if (options.emptyWorkflowLists && workflowListCalls++ < options.emptyWorkflowLists) return { workflows: [] }
      return { workflows: [{ id: 700, name: options.workflowName || 'Migration Worker', path: options.workflowPath || '.github/workflows/migration-worker.yml', state: options.workflowState || 'active' }] }
    }
    if (url.includes('/actions/workflows/')) return { state: options.workflowState || 'active' }
    const found = repos.find(r => url === `/repos/${r.full_name}`)
    if (found) return found
    if (url === '/repos/me/renamed-500') return repo(500, { fork: true, source: { id: 1 } })
    throw new setup.GitHubApiError('Not found', 404)
  }
  setup = loadSetup(api)
  return { ...setup, calls }
}
test('detects a renamed marker repository beyond the first hundred among unrelated repositories', async () => {
  const repos = Array.from({ length: 125 }, (_, i) => repo(i + 10))
  const f = fixture(repos, { marked: [134] })
  let result = await f.advanceWorkerSetup('token')
  while (result.status === 'pending') result = await f.advanceWorkerSetup('token', result.cursor)
  assert.equal(result.status, 'ready')
  assert.equal(result.repo.id, '134')
  assert.equal(result.repo.defaultBranch, 'custom')
  assert.ok(!f.calls.some(c => c.method === 'POST'))
})
test('detects old renamed forks by ancestry without a marker', async () => {
  const f = fixture([repo(9, { fork: true, source: { id: 1 } })])
  assert.equal((await f.advanceWorkerSetup('token')).repo.id, '9')
})
test('does not guess between matching copies', async () => {
  const f = fixture([repo(9), repo(10)], { marked: [9, 10] })
  const choice = await f.advanceWorkerSetup('token')
  assert.equal(choice.status, 'choose')
  assert.equal((await f.advanceWorkerSetup('token', choice.cursor, '10')).repo.id, '10')
  await assert.rejects(f.advanceWorkerSetup('token', choice.cursor, '99'), /detected matches/)
})
test('complete empty scan requests a deterministic fork then verifies readiness', async () => {
  const f = fixture([])
  const pending = await f.advanceWorkerSetup('token')
  assert.equal(pending.status, 'pending')
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
  assert.equal((await f.advanceWorkerSetup('token', pending.cursor)).repo.id, '500')
})
test('auto detection forks instead of selecting the upstream template repository', async () => {
  const f = fixture([source])
  const pending = await f.advanceWorkerSetup('token')
  assert.equal(pending.status, 'pending')
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
  assert.ok(f.calls.some(c => c.url.endsWith('/forks')))
})
test('API failure during detection never creates a fork', async () => {
  const f = fixture([repo(9)], { fail: url => url.includes('.drive-worker.json') })
  await assert.rejects(f.advanceWorkerSetup('token'), /Rate limited/)
  assert.ok(!f.calls.some(c => c.method === 'POST'))
})
test('read-only matching repositories block automatic fork creation', async () => {
  const f = fixture([repo(9, { permissions: { push: false } })], { marked: [9] })
  await assert.rejects(f.advanceWorkerSetup('token'), /admin and push/)
  assert.ok(!f.calls.some(c => c.method === 'POST'))
})
test('continuation cannot be forged or reused with a different account token', async () => {
  const f = fixture(Array.from({ length: 10 }, (_, i) => repo(i + 10)))
  const result = await f.advanceWorkerSetup('token')
  await assert.rejects(f.advanceWorkerSetup('other-token', result.cursor), /session changed/)
  await assert.rejects(f.advanceWorkerSetup('token', `X${result.cursor}`), /session changed/)
})
test('fork workflow is enabled before selection', async () => {
  const f = fixture([repo(9)], { marked: [9], workflowState: 'disabled_fork' })
  const result = await f.advanceWorkerSetup('token')
  assert.equal(result.status, 'pending')
  assert.ok(f.calls.some(c => c.method === 'PUT' && c.url.endsWith('/enable')))
})
test('auto setup returns the actual compatible workflow path instead of a hardcoded filename', async () => {
  const workflowPath = '.github/workflows/custom-drive-runner.yaml'
  const f = fixture([repo(9)], { marked: [9], workflowPath })
  let result = await f.advanceWorkerSetup('token')
  while (result.status === 'pending') result = await f.advanceWorkerSetup('token', result.cursor)
  assert.equal(result.status, 'ready')
  assert.equal(result.workflow, workflowPath)
})
test('fork setup waits when GitHub has not indexed its workflow yet', async () => {
  const f = fixture([], { emptyWorkflowLists: 1 })
  const fork = await f.advanceWorkerSetup('token')
  assert.equal(fork.status, 'pending')
  const waiting = await f.advanceWorkerSetup('token', fork.cursor)
  assert.equal(waiting.status, 'pending')
  const ready = await f.advanceWorkerSetup('token', waiting.cursor)
  assert.equal(ready.status, 'ready')
})
test('workflow listing excludes Actions records whose files no longer exist', async () => {
  const oauth = loadOAuth()
  const originalFetch = global.fetch
  const requestedUrls = []
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) })
  global.fetch = async (input) => {
    const url = String(input)
    requestedUrls.push(url)
    if (url.includes('/actions/workflows?per_page=100')) {
      return response({ workflows: [
        null,
        { id: 3, name: 'Malformed', path: null, state: 'active' },
        { id: 1, name: 'Present', path: '.github/workflows/present.yml', state: 'active' },
        { id: 2, name: 'Removed', path: '.github/workflows/removed.yml', state: 'active' },
      ] })
    }
    if (url.includes('/contents/.github/workflows/present.yml')) return response({ type: 'file', path: '.github/workflows/present.yml' })
    if (url.includes('/contents/.github/workflows/removed.yml')) return response({ message: 'Not Found' }, 404)
    return response({ message: 'Unexpected request' }, 500)
  }
  try {
    assert.deepEqual(await oauth.listGitHubWorkflows('token', 'me', 'repo', 'feature/test'), [{ id: '1', name: 'Present', path: '.github/workflows/present.yml', state: 'active' }])
    assert.ok(requestedUrls.some((url) => url.includes('ref=feature%2Ftest')))
  } finally {
    global.fetch = originalFetch
  }
})
test('workflow listing paginates beyond the first hundred records', async () => {
  const oauth = loadOAuth()
  const originalFetch = global.fetch
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) })
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Workflow ${index + 1}`,
    path: `.github/workflows/workflow-${index + 1}.yml`,
    state: 'active',
  }))
  const pageTwo = [{ id: 101, name: 'Worker', path: '.github/workflows/worker.yml', state: 'active' }]
  global.fetch = async (input) => {
    const url = String(input)
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/actions/workflows')) {
      return response({ workflows: parsed.searchParams.get('page') === '2' ? pageTwo : pageOne })
    }
    if (parsed.pathname.includes('/contents/.github/workflows/')) {
      const workflowPath = decodeURIComponent(parsed.pathname.split('/contents/')[1])
      return response({ type: 'file', path: workflowPath })
    }
    return response({ message: 'Unexpected request' }, 500)
  }
  try {
    const workflows = await oauth.listGitHubWorkflows('token', 'me', 'repo')
    assert.equal(workflows.length, 101)
    assert.equal(workflows.at(-1).path, '.github/workflows/worker.yml')
  } finally {
    global.fetch = originalFetch
  }
})
test('compatible workflow listing detects the current migration worker contract', async () => {
  const oauth = loadOAuth()
  const originalFetch = global.fetch
  const workflowPath = '.github/workflows/migration-worker.yml'
  const workflowContent = fs.readFileSync(path.resolve(workflowPath), 'utf8')
  const response = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) })
  global.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/actions/workflows?')) {
      return response({ workflows: [{ id: 1, name: 'Migration Worker', path: workflowPath, state: 'active' }] })
    }
    if (url.includes('/contents/.github/workflows/migration-worker.yml')) {
      return response({ type: 'file', path: workflowPath, encoding: 'base64', content: Buffer.from(workflowContent).toString('base64') })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  try {
    const workflows = await oauth.listGitHubWorkflows('token', 'me', 'repo', 'main', true)
    assert.deepEqual(workflows, [{ id: '1', name: 'Migration Worker', path: workflowPath, state: 'active' }])
  } finally {
    global.fetch = originalFetch
  }
})
test('dashboard workflow picker has no repository-independent fallback item', () => {
  const page = fs.readFileSync(path.resolve('src/app/dashboard/workers/page.tsx'), 'utf8')
  assert.doesNotMatch(page, /<SelectItem value=["']\.github\/workflows\/migration-worker\.yml["']/)
  assert.match(page, /githubWorkflows\.map\(\(workflow\)/)
  assert.match(page, /typeof workflows\[0\]\?\.path === "string" \? workflows\[0\]\.path : ""/)
  assert.doesNotMatch(page, /<Select disabled=\{repositoryMode === "auto" \|\|/)
  assert.doesNotMatch(page, /<SelectItem value="self_hosted">/)
  assert.match(page, /Self-hosted workers register themselves with the shared secret and orchestrator URL/)
})
test('migration worker workflow exposes the dispatch contract used by the panel', () => {
  const workflowFile = fs.readFileSync(path.resolve('.github/workflows/migration-worker.yml'), 'utf8')
  assert.doesNotMatch(workflowFile, /workflow_dispatch:/)
  assert.match(workflowFile, /repository_dispatch:/)
  assert.match(workflowFile, /types: \[drive-migration-worker\]/)
  assert.match(workflowFile, /working-directory: workers\/migration-worker/)
  assert.match(workflowFile, /cache-dependency-path: workers\/migration-worker\/package-lock\.json/)
  assert.match(workflowFile, /run: npm ci/)
  assert.match(workflowFile, /run: npm start/)
  assert.match(workflowFile, /AGENT_ID:/)
  assert.match(workflowFile, /github\.event\.client_payload\.worker_instance_id/)
  assert.match(workflowFile, /Run \$\{\{ github\.run_number \}\} \/ Worker/)
  assert.match(workflowFile, /WORKER_INSTANCE_ID: \$\{\{ github\.event\.client_payload\.worker_instance_id \|\| github\.run_id \}\}/)
  assert.match(workflowFile, /SERVER_URL: \$\{\{ secrets\.DRIVE_MIGRATION_ORCHESTRATOR_URL \}\}/)
  assert.match(workflowFile, /TOKEN: \$\{\{ secrets\.DRIVE_WORKER_SHARED_SECRET \}\}/)
  assert.doesNotMatch(workflowFile, /^\s+POSTGRES_URL:/m)
  assert.doesNotMatch(workflowFile, /^\s+inputs:/m)
})

test('registered workflows dispatch only vacant independent worker capacity', () => {
  const dispatchRoute = fs.readFileSync(path.resolve('src/app/api/agents/[id]/dispatch/route.ts'), 'utf8')
  const workerRoute = fs.readFileSync(path.resolve('src/app/api/workers/[id]/route.ts'), 'utf8')
  const schema = fs.readFileSync(path.resolve('supabase/drive_schema.sql'), 'utf8')
  assert.match(dispatchRoute, /agent\.workerCount - activeDispatchRuns\.length/)
  assert.match(dispatchRoute, /workerInstanceId: additionalInstanceId/)
  assert.match(dispatchRoute, /worker_instance_id: instanceId/)
  assert.match(dispatchRoute, /\(pool \|\| !run\.jobReference/)
  assert.match(workerRoute, /action === "stop_run"/)
  assert.match(schema, /worker_count integer not null default 1 check \(worker_count between 1 and 5\)/)
  const orchestrator = fs.readFileSync(path.resolve('workers/migration-orchestrator/src/index.ts'), 'utf8')
  const runtime = fs.readFileSync(path.resolve('workers/migration-worker/migration-worker.mjs'), 'utf8')
  assert.match(orchestrator, /path === "\/workers\/register"/)
  assert.match(orchestrator, /worker_count.*active\.rows\[0\]\?\.count/)
  assert.match(orchestrator, /worker_instance_id: workerInstanceId/)
  assert.match(orchestrator, /maxDispatchesPerCycle, 100, 1, 100/)
  assert.match(runtime, /claimedWorkerInstanceId: WORKER_INSTANCE_ID/)
  const migrationPage = fs.readFileSync(path.resolve('src/app/dashboard/migrations/[id]/page.tsx'), 'utf8')
  assert.match(migrationPage, /workerIds\.slice\(0, 1\)/)
  assert.match(migrationPage, /poolAgentIds:/)
  assert.match(orchestrator, /GITHUB_DISPATCH_QUEUE/)
  assert.match(orchestrator, /reconcileGitHubIntent/)
  assert.match(orchestrator, /migration_inventory_file/)
  assert.match(runtime, /inspectAssignedObjects/)
  assert.match(runtime, /assignedInventory/)
  assert.match(orchestrator, /encode\(convert_to\(\$4::text,'UTF8'\),'hex'\)/)
  assert.match(orchestrator, /key>\$2 order by key limit 100/)
  assert.match(orchestrator, /control: "cycle"/)
  assert.doesNotMatch(orchestrator, /\/250/)
  assert.match(runtime, /createHash\("sha256"\)/)
  assert.match(runtime, /sourceSha256 === destinationSha256/)
  assert.match(orchestrator, /status='canceled'/)
})

test('workflow compatibility requires the orchestrator URL and shared worker secret contract', () => {
  const f = fixture([])
  const current = fs.readFileSync(path.resolve('.github/workflows/migration-worker.yml'), 'utf8')
  assert.equal(f.isWorkerWorkflow(current), true)
  assert.equal(f.isWorkerWorkflow(current.replace('DRIVE_WORKER_SHARED_SECRET', 'UNRELATED_SECRET')), false)
  assert.equal(f.isWorkerWorkflow('name: unrelated\non:\n  workflow_dispatch:\n'), false)
})

test('migration UI exposes both engines while preserving Super Slurper as the default', () => {
  const page = fs.readFileSync(path.resolve('src/app/dashboard/migrations/page.tsx'), 'utf8')
  const details = fs.readFileSync(path.resolve('src/app/dashboard/migrations/[id]/page.tsx'), 'utf8')
  const dispatch = fs.readFileSync(path.resolve('src/app/api/agents/[id]/dispatch/route.ts'), 'utf8')
  assert.match(page, /useState<"super_slurper" \| "migration_workers">\("super_slurper"\)/)
  assert.match(page, /<SelectItem value="super_slurper">Cloudflare Super Slurper<\/SelectItem>/)
  assert.match(page, /<SelectItem value="migration_workers">Drive migration worker pool<\/SelectItem>/)
  assert.doesNotMatch(page, /Parallel object shards/)
  assert.match(details, /scanner-indexed per-file queue/)
  assert.match(details, /executionMode === "migration_workers" \? "migration" : workerMode/)
  assert.match(details, /if \(mode === "migration"\) return "Migration"/)
  assert.match(dispatch, /const mode: RepairJobMode = pool \? "migration" : requestedMode/)
})

test('worker totals sum configured workflow capacity instead of counting workflow rows', () => {
  const workers = fs.readFileSync(path.resolve('src/app/dashboard/workers/page.tsx'), 'utf8')
  assert.match(workers, /agent\.provider === "github_actions" \? agent\.workerCount : 1/)
  assert.match(workers, /Registered Workflows/)
  assert.match(workers, /Configured worker capacity/)
})

test('migration worker pool documentation and schema keep the shared queue contract explicit', () => {
  const schema = fs.readFileSync(path.resolve('supabase/drive_schema.sql'), 'utf8')
  const orchestratorReadme = fs.readFileSync(path.resolve('workers/migration-orchestrator/README.md'), 'utf8')
  const workerReadme = fs.readFileSync(path.resolve('workers/migration-worker/README.md'), 'utf8')
  const orchestrator = fs.readFileSync(path.resolve('workers/migration-orchestrator/src/index.ts'), 'utf8')
  const action = fs.readFileSync(path.resolve('src/app/api/migrations/[id]/action/route.ts'), 'utf8')
  assert.match(schema, /work_key text/)
  assert.match(schema, /drive_repair_jobs_work_key_unique/)
  assert.match(schema, /create table if not exists drive_app_settings/)
  assert.match(orchestratorReadme, /File Scanner inventory/)
  assert.match(orchestratorReadme, /migration_workers/)
  assert.match(workerReadme, /scanner-indexed source file/)
  assert.match(orchestrator, /'pending','migration'/)
  assert.doesNotMatch(orchestrator, /Verification issues queued for repair/)
  assert.match(action, /action === "repair_migration"/)
  assert.match(action, /action === "verify_all"/)
  assert.match(action, /wakeMigrationService\("scanner"\)/)
})

test('migration and file orchestrators operate through durable shared state without runtime panel callbacks', () => {
  const migration = fs.readFileSync(path.resolve('workers/migration-orchestrator/src/index.ts'), 'utf8')
  const orchestrator = migration
  const file = fs.readFileSync(path.resolve('workers/file-scanner/src/index.ts'), 'utf8')
  const worker = fs.readFileSync(path.resolve('workers/migration-worker/migration-worker.mjs'), 'utf8')
  const liveState = fs.readFileSync(path.resolve('src/lib/migration-live-state.ts'), 'utf8')
  const panelSync = fs.readFileSync(path.resolve('src/app/api/migrations/[id]/sync/route.ts'), 'utf8')
  assert.match(migration, /POSTGRES_URL/)
  assert.match(migration, /drive_migration_verification_state/)
  assert.match(migration, /verifyStrictDestination/)
  assert.match(migration, /Migration worker retries exhausted/)
  assert.doesNotMatch(migration, /api\/internal\/migration-orchestrator\/tick/)
  assert.match(file, /drive_bucket_scan_objects/)
  assert.match(file, /for update of v skip locked/)
  assert.match(file, /claimGenericScan/)
  assert.match(file, /R2 returned a truncated page without a forward cursor/)
  assert.match(file, /integrityProofs/)
  assert.match(file, /destinationEtag/)
  assert.match(file, /function pageSize\(_env: Env\) \{ return 100 \}/)
  assert.match(file, /ListObjectsV2Command/)
  assert.match(file, /c\.r2_access_key_id,c\.r2_secret_access_key/)
  assert.doesNotMatch(file, /c\.api_token/)
  assert.match(orchestrator, /const hasRunnableFiles = shards\.shardCount > 0 \|\| shards\.created > 0/)
  assert.doesNotMatch(file, /m\.options->>'executionMode'='migration_workers'/)
  assert.doesNotMatch(file, /s\.migration_item_id is null/)
  const sourceScanQueue = panelSync.slice(
    panelSync.indexOf('const incompleteSourceScans'),
    panelSync.indexOf('// Refresh progress for any created jobs.')
  )
  const workerVerificationQueue = panelSync.slice(
    panelSync.indexOf('const workerVerifyEnabled'),
    panelSync.indexOf('// Post-copy verification:')
  )
  assert.match(sourceScanQueue, /wakeFileScanner\(\)/)
  assert.doesNotMatch(sourceScanQueue, /runBucketScanBatch/)
  assert.match(workerVerificationQueue, /ensureFileVerification/)
  assert.match(workerVerificationQueue, /wakeFileScanner\(\)/)
  assert.doesNotMatch(workerVerificationQueue, /runBucketScanBatch|computeAndStoreVerifyDiffs/)
  assert.match(worker, /claimJobDirect/)
  assert.match(worker, /for update skip locked/)
  assert.match(worker, /claim_token=gen_random_uuid/)
  assert.match(worker, /loadRuntimeConfiguration/)
  assert.match(liveState, /requireIndependentVerification !== false/)
})

test('lost fork response is reconciled using the stable destination without another POST', async () => {
  const existing = repo(500, { fork: true, source: { id: 1 } })
  const f = fixture([], { existingFork: existing })
  const pending = await f.advanceWorkerSetup('token')
  assert.equal(pending.status, 'pending')
  assert.equal((await f.advanceWorkerSetup('token', pending.cursor)).repo.id, '500')
  assert.ok(!f.calls.some(c => c.method === 'POST'))
})
test('unrelated destination name collision is never overwritten', async () => {
  const f = fixture([], { existingFork: repo(500) })
  await assert.rejects(f.advanceWorkerSetup('token'), /already exists and is unrelated/)
  assert.ok(!f.calls.some(c => c.method !== 'GET'))
})
test('archived marker repository is not automatically selected or replaced', async () => {
  const f = fixture([repo(9, { archived: true })], { marked: [9] })
  await assert.rejects(f.advanceWorkerSetup('token'), /none allow worker setup/)
  assert.ok(!f.calls.some(c => c.method !== 'GET'))
})
test('read-only upstream in the list does not prevent creating a personal fork', async () => {
  const f = fixture([{ ...source, permissions: { push: false, admin: false } }])
  assert.equal((await f.advanceWorkerSetup('token')).status, 'pending')
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1)
})
