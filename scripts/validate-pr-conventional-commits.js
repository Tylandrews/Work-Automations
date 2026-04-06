/**
 * Ensures each commit in a PR range uses Conventional Commits so
 * scripts/generate-release-changelog.js can place lines in Added / Fixed / etc.
 * (changelog-bundled.json powers Account → Release notes in the app.)
 *
 * CI sets BASE_SHA and HEAD_SHA from the pull_request event.
 */
const { execSync } = require('child_process')
const path = require('path')
const { isConventionalOrRevertSubject } = require('./commit-conventions')

const root = path.join(__dirname, '..')

const main = () => {
  const base = String(process.env.BASE_SHA || '').trim()
  const head = String(process.env.HEAD_SHA || '').trim()
  if (!base || !head) {
    console.error('ERROR: Set BASE_SHA and HEAD_SHA (pull_request.base.sha and pull_request.head.sha)')
    process.exit(1)
  }

  const cmd = `git log ${base}..${head} --no-merges --pretty=format:%s`
  let out = ''
  try {
    out = execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    console.error('ERROR: git log failed. Use fetch-depth: 0 on checkout.', err.message || err)
    process.exit(1)
  }

  const subjects = out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  const bad = []
  for (const s of subjects) {
    if (!isConventionalOrRevertSubject(s)) {
      bad.push(s)
    }
  }

  if (bad.length) {
    console.error(
      'These commit subjects are not Conventional Commits. They would land only under "Other" or break release-note grouping in the app:'
    )
    for (const s of bad) {
      console.error(`  - ${s}`)
    }
    console.error('')
    console.error('Use: type(optional-scope): description')
    console.error('Types: feat, fix, perf, refactor, chore, ci, build, docs, test, style')
    console.error('Example: fix(call-log): correct search debounce (fixes #42)')
    process.exit(1)
  }

  console.log(`OK: ${subjects.length} commit(s) in range are release-notes ready`)
}

main()
