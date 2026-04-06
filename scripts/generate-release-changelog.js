/**
 * Builds release notes from git history between the previous semver tag and the given tag,
 * updates CHANGELOG.md (prepend, idempotent per version), changelog-bundled.json (for the app),
 * and writes release-notes.md for softprops/action-gh-release body_path.
 *
 * Usage: node scripts/generate-release-changelog.js v3.4.10
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { classifySubject } = require('./commit-conventions')

const root = path.join(__dirname, '..')

const runGit = (cmd) => {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const stripV = (tag) => String(tag || '').replace(/^v/i, '')

const parseArgs = () => {
  const raw = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const tag = String(raw[0] || '').trim()
  if (!tag) {
    console.error('ERROR: Tag argument required (example: v3.4.10)')
    process.exit(1)
  }
  if (!/^v\d+\.\d+\.\d+$/i.test(tag)) {
    console.error(`ERROR: Invalid tag "${tag}". Expected vX.Y.Z`)
    process.exit(1)
  }
  return tag
}

const listSemverTagsDesc = () => {
  const out = runGit('git tag -l "v*.*.*" --sort=-version:refname')
  return out ? out.split(/\n/).map((t) => t.trim()).filter(Boolean) : []
}

const getPreviousTag = (currentTag) => {
  const tags = listSemverTagsDesc()
  const i = tags.indexOf(currentTag)
  if (i === -1) {
    console.error(`ERROR: Tag ${currentTag} not found in repository`)
    process.exit(1)
  }
  return tags[i + 1] || null
}

const getCommitSubjects = (prevTag, endRef) => {
  const cmd = prevTag
    ? `git log ${prevTag}..${endRef} --no-merges --pretty=format:%s`
    : `git log ${endRef} --no-merges --pretty=format:%s`
  const out = runGit(cmd)
  return out ? out.split(/\n/).map((s) => s.trim()).filter(Boolean) : []
}

const getReleaseDateIso = (endRef) => {
  const line = runGit(`git log -1 --format=%cs ${endRef}`)
  return line || new Date().toISOString().slice(0, 10)
}

const bucketToHeading = {
  added: 'Added',
  fixed: 'Fixed',
  changed: 'Changed',
  maintenance: 'Maintenance',
  other: 'Other'
}

const buildBuckets = (subjects) => {
  const buckets = {
    added: [],
    fixed: [],
    changed: [],
    maintenance: [],
    other: []
  }
  const seen = new Set()
  for (const subject of subjects) {
    const row = classifySubject(subject)
    if (!row) continue
    const key = `${row.bucket}:${row.text}`
    if (seen.has(key)) continue
    seen.add(key)
    buckets[row.bucket].push(row.text)
  }
  return buckets
}

const formatMarkdownSection = (version, dateIso, buckets) => {
  const lines = [`## [${version}] - ${dateIso}`, '']
  const order = ['added', 'fixed', 'changed', 'maintenance', 'other']
  let any = false
  for (const key of order) {
    const items = buckets[key]
    if (!items.length) continue
    any = true
    lines.push(`### ${bucketToHeading[key]}`, '')
    for (const t of items) {
      lines.push(`- ${t}`)
    }
    lines.push('')
  }
  if (!any) {
    lines.push('### Summary', '', '- See commit history for this release.', '')
  }
  return lines.join('\n')
}

const formatReleaseNotesMd = (version, dateIso, buckets, tag) => {
  const prettyDate = new Date(`${dateIso}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })
  const lines = [
    `# Call Log v${version}`,
    '',
    `**Release date:** ${prettyDate} (${dateIso})`,
    '',
    `Tagged as \`${tag}\`.`,
    '',
    '## Changes',
    ''
  ]
  const order = ['added', 'fixed', 'changed', 'maintenance', 'other']
  for (const key of order) {
    const items = buckets[key]
    if (!items.length) continue
    lines.push(`### ${bucketToHeading[key]}`, '')
    for (const t of items) {
      lines.push(`- ${t}`)
    }
    lines.push('')
  }
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const prependChangelog = (version, block) => {
  const changelogPath = path.join(root, 'CHANGELOG.md')
  const intro = `# Changelog

All notable changes to **Call Log** are recorded here. Each GitHub release updates this file from commits since the previous version tag.

`
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^## \\[${escaped}\\]`, 'm')
  let raw = ''
  if (fs.existsSync(changelogPath)) {
    raw = fs.readFileSync(changelogPath, 'utf8')
  }
  if (re.test(raw)) {
    console.log(`CHANGELOG.md already contains [${version}]; skipping prepend`)
    return
  }
  let output
  if (!raw.trim()) {
    output = `${intro.trim()}\n\n${block}\n`
  } else if (raw.startsWith('# Changelog')) {
    const idx = raw.search(/\n## \[/)
    if (idx === -1) {
      output = `${raw.trimEnd()}\n\n${block}\n`
    } else {
      const head = raw.slice(0, idx).trimEnd()
      const tail = raw.slice(idx).trimStart()
      output = `${head}\n\n${block}\n${tail}\n`
    }
  } else {
    output = `${intro.trim()}\n\n${block}\n${raw}`
  }
  fs.writeFileSync(changelogPath, output, 'utf8')
  console.log('Updated CHANGELOG.md')
}

const mergeBundledJson = (version, dateIso, buckets) => {
  const bundledPath = path.join(root, 'changelog-bundled.json')
  let data = { releases: [] }
  if (fs.existsSync(bundledPath)) {
    try {
      data = JSON.parse(fs.readFileSync(bundledPath, 'utf8'))
    } catch {
      data = { releases: [] }
    }
  }
  if (!Array.isArray(data.releases)) data.releases = []

  const entry = {
    version,
    date: dateIso,
    sections: {
      Added: buckets.added,
      Fixed: buckets.fixed,
      Changed: buckets.changed,
      Maintenance: buckets.maintenance,
      Other: buckets.other
    }
  }
  data.releases = data.releases.filter((r) => String(r.version) !== version)
  data.releases.unshift(entry)
  const max = 24
  if (data.releases.length > max) {
    data.releases = data.releases.slice(0, max)
  }
  fs.writeFileSync(bundledPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log('Updated changelog-bundled.json')
}

const main = () => {
  const tag = parseArgs()
  const version = stripV(tag)
  const prevTag = getPreviousTag(tag)
  const subjects = getCommitSubjects(prevTag, tag)
  const dateIso = getReleaseDateIso(tag)
  const buckets = buildBuckets(subjects)
  const changelogBlock = formatMarkdownSection(version, dateIso, buckets)
  const releaseNotes = formatReleaseNotesMd(version, dateIso, buckets, tag)

  const releaseNotesPath = path.join(root, 'release-notes.md')
  fs.writeFileSync(releaseNotesPath, `${releaseNotes}\n`, 'utf8')
  console.log('Wrote release-notes.md')

  prependChangelog(version, changelogBlock)
  mergeBundledJson(version, dateIso, buckets)
}

main()
