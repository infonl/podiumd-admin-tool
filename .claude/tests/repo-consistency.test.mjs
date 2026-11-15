// Consistency checks between files that must list the same things: the CI
// jobs and the required-check lists in the role files, the check.sh areas and
// the CLAUDE.md commands, and the path-gate regexes and the README table.
// Adding a CI area used to need hand-written edits in several places, and some
// were missed (docs/review-lessons.md). These tests fail on that drift.
//
// Run with: node --test ".claude/tests/*.test.mjs"   (or: check.sh hooks)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

// ---------- required checks

// The job names of ci.yml (the `name:` of each job, apart from the `changes`
// helper) and the CodeQL legs, which report as "CodeQL (<language>)".
function ciCheckNames() {
  const ci = read('.github', 'workflows', 'ci.yml')
  const jobs = [...ci.matchAll(/^ {2}[a-z][a-z0-9-]*:\n {4}name: ([^\n$]+)$/gm)].map(m => m[1].trim()).filter(n => n !== 'changes')
  const codeql = read('.github', 'workflows', 'codeql.yml')
  const languages = /language: \[([^\]]+)\]/.exec(codeql)
  assert.ok(languages, 'codeql.yml: cannot find the language matrix')
  const legs = languages[1].split(',').map(l => `CodeQL (${l.trim()})`)
  assert.ok(jobs.length >= 4, `ci.yml: found only ${jobs.length} jobs`)
  return [...jobs, ...legs]
}

// Every file that lists the required checks, with a pattern for the line or
// paragraph that holds the list.
const REQUIRED_CHECK_LISTS = [
  ['.claude/agents/platform-engineer.md', /\*\*Required checks:\*\*[^\n]*/],
  ['.claude/agents/task-manager.md', /`main` is protected: PRs only, with required checks[^\n]*/],
  ['.github/instructions/platform.instructions.md', /\*\*Required checks\*\*[^\n]*/],
]

test('every required-check list names every CI job and CodeQL leg', () => {
  const names = ciCheckNames()
  for (const [file, pattern] of REQUIRED_CHECK_LISTS) {
    const list = pattern.exec(read(file))
    assert.ok(list, `${file}: cannot find the required-check list`)
    for (const name of names) assert.ok(list[0].includes(`\`${name}\``), `${file}: the required-check list does not name \`${name}\``)
  }
})

// ---------- check.sh areas

test('CLAUDE.md shows a command for every check.sh area', () => {
  const areas = [...read('.github', 'scripts', 'check.sh').matchAll(/^ {4}([a-z]+)\) [a-z]+=true/gm)].map(m => m[1])
  assert.ok(areas.length >= 5, `check.sh: found only ${areas.length} areas`)
  const claude = read('CLAUDE.md')
  for (const area of areas) assert.match(claude, new RegExp(`check\\.sh ${area}\\b`), `CLAUDE.md: no \`check.sh ${area}\` in the commands`)
})

// ---------- path gate: changed-areas.sh regexes and the README table

// The README row label of each area regex in changed-areas.sh.
const AREA_ROWS = {
  backend_re: '`backend`',
  frontend_re: '`frontend`',
  image_re: '`image`',
  codeql_python_re: 'CodeQL (python)',
  codeql_js_re: 'CodeQL (javascript-typescript)',
}

// The plain path alternatives of a regex (anchored, no groups), as the README
// writes them: `backend/`, `.nvmrc`, `ci.yml` for .github/workflows/ci.yml.
function plainPaths(regex) {
  return regex
    .split('|')
    .filter(alt => alt.startsWith('^') && !/[()[\]{}?*+]/.test(alt.replace(/\\\./g, '')) && !alt.includes('${'))
    .map(alt => alt.replace(/^\^/, '').replace(/\$$/, '').replace(/\\/g, ''))
    .map(path => (path.startsWith('.github/workflows/') ? path.slice('.github/workflows/'.length) : path))
}

test('the README path-gate table lists every plain path of each area regex', () => {
  const script = read('.github', 'scripts', 'changed-areas.sh')
  const readme = read('README.md')
  const rows = Object.fromEntries(
    readme
      .split('\n')
      .filter(line => line.startsWith('|'))
      .map(line => line.split('|').map(cell => cell.trim()))
      .filter(cells => cells.length >= 3)
      .map(cells => [cells[1], cells[2]]),
  )
  for (const [variable, label] of Object.entries(AREA_ROWS)) {
    const match = new RegExp(`^${variable}="([^"]+)"`, 'm').exec(script)
    assert.ok(match, `changed-areas.sh: cannot find ${variable}`)
    const row = rows[label]
    assert.ok(row, `README.md: no path-gate row for ${label}`)
    for (const path of plainPaths(match[1])) assert.ok(row.includes(`\`${path}\``), `README.md: the ${label} row does not list \`${path}\` (from ${variable})`)
  }
})

// ---------- review lessons

test('docs/review-lessons.md entries follow the format', () => {
  const entries = read('docs', 'review-lessons.md')
    .split('\n')
    .filter(line => line.startsWith('- ['))
  assert.ok(entries.length > 0, 'docs/review-lessons.md: no entries')
  for (const entry of entries) assert.match(entry, /^- \[[a-z]+\] .+ → .+$/, `docs/review-lessons.md: malformed entry "${entry}"`)
})
