/**
 * Shared rules for conventional commit subjects used by:
 * - generate-release-changelog.js (buckets for CHANGELOG / changelog-bundled.json)
 * - validate-pr-conventional-commits.js (CI guard)
 */
const MERGE_RE = /^merge(\s|$)/i
const CONV_RE =
  /^(feat|fix|perf|refactor|chore|ci|build|docs|test|style)(\([^)]+\))?\s*:\s*(.+)$/i
const VERSION_ONLY_RE = /^\d+\.\d+\.\d+$/
const GIT_STATUS_JUNK_RE = /(^|\t|\s)modified:\s+/i
const REVERT_SUBJ_RE = /^revert\b/i

const shouldIgnoreSubject = (subject) => {
  if (!subject || MERGE_RE.test(subject)) return true
  if (VERSION_ONLY_RE.test(subject.trim())) return true
  if (GIT_STATUS_JUNK_RE.test(subject)) return true
  return false
}

const classifySubject = (subject) => {
  if (shouldIgnoreSubject(subject)) return null
  const m = subject.match(CONV_RE)
  if (!m) {
    return { bucket: 'other', text: subject }
  }
  const kind = m[1].toLowerCase()
  const text = m[3].trim()
  if (kind === 'feat') return { bucket: 'added', text }
  if (kind === 'fix') return { bucket: 'fixed', text }
  if (kind === 'perf' || kind === 'refactor') return { bucket: 'changed', text }
  if (
    kind === 'chore' ||
    kind === 'ci' ||
    kind === 'build' ||
    kind === 'docs' ||
    kind === 'test' ||
    kind === 'style'
  ) {
    return { bucket: 'maintenance', text }
  }
  return { bucket: 'other', text }
}

/**
 * True if this subject is suitable for PR / main history (shows up in a named changelog bucket).
 * Revert commits are allowed without full conventional form.
 */
const isConventionalOrRevertSubject = (subject) => {
  const s = String(subject || '').trim()
  if (shouldIgnoreSubject(s)) return true
  if (REVERT_SUBJ_RE.test(s)) return true
  return CONV_RE.test(s)
}

module.exports = {
  MERGE_RE,
  CONV_RE,
  shouldIgnoreSubject,
  classifySubject,
  isConventionalOrRevertSubject
}
