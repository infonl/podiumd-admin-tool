// Tests for the two scripts that do the task-manager's mechanical GitHub steps:
// .github/scripts/collect-pr-feedback.mjs and apply-pr-triage.mjs. A stub `gh`
// first on PATH answers from a state directory and logs every call, so nothing
// touches GitHub.
//
// Run with: node --test ".claude/tests/*.test.mjs"   (or: check.sh hooks)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = name => join(root, '.github', 'scripts', name)

const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = process.env.STUB
const args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify(args) + '\\n')
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
const text = args.join(' ')
const say = s => { process.stdout.write(s + '\\n'); process.exit(0) }
const fail = s => { process.stderr.write(s + '\\n'); process.exit(1) }
for (const bad of state.failOn || []) if (text.includes(bad)) fail('stub gh: refused ' + bad)
if (text.startsWith('pr view') && text.includes('headRefName')) {
  const n = Number(fs.readFileSync(path.join(dir, 'views'), 'utf8')) + 1
  fs.writeFileSync(path.join(dir, 'views'), String(n))
  say(JSON.stringify({ headRefName: state.branch, headRefOid: n <= (state.movedHeadViews || 0) ? 'head2' : 'head1' }))
}
if (text.startsWith('pr view')) say('head1')
if (text.startsWith('pr checks')) {
  const n = Number(fs.readFileSync(path.join(dir, 'polls'), 'utf8')) + 1
  fs.writeFileSync(path.join(dir, 'polls'), String(n))
  say('{"total":1,"pending":0,"failed":0,"checks":[{"name":"backend","bucket":"pass"}]}')
}
if (text.startsWith('api --paginate') && text.includes('tojson')) say(state.reviews.filter(r => r.body).map(r => JSON.stringify(r)).join('\\n'))
if (text.startsWith('api --paginate')) say(state.reviewedCommit)
if (text.startsWith('api graphql --paginate')) say(state.threads.map(t => JSON.stringify(t)).join('\\n'))
if (text.includes('addPullRequestReviewThreadReply')) say('https://example.test/reply')
if (text.includes('resolveReviewThread')) say(String(state.resolves !== false))
if (text.startsWith('issue list')) say((state.issues || []).map(i => JSON.stringify(i)).join('\\n'))
if (text.startsWith('issue create')) say('https://example.test/issues/9')
if (text.startsWith('pr comment')) say('https://example.test/comment')
if (text.startsWith('pr edit')) say('')
fail('stub gh: unexpected call: ' + text)
`

// run(scriptName, args, state): run a script against the stub; returns { status, json, stderr, calls }.
function run(name, args, state = {}) {
  const work = mkdtempSync(join(tmpdir(), 'pr-steps-'))
  mkdirSync(join(work, 'bin'))
  writeFileSync(join(work, 'bin', 'gh'), STUB)
  chmodSync(join(work, 'bin', 'gh'), 0o755)
  writeFileSync(join(work, 'calls'), '')
  writeFileSync(join(work, 'polls'), '0')
  writeFileSync(join(work, 'views'), '0')
  writeFileSync(join(work, 'state.json'), JSON.stringify({ branch: 'feat/x', reviewedCommit: 'head1', threads: [], reviews: [], ...state }))
  const files = args.map(a => {
    if (typeof a === 'string') return a
    const file = join(work, 'triage.json')
    writeFileSync(file, typeof a.raw === 'string' ? a.raw : JSON.stringify(a))
    return file
  })
  const r = spawnSync(process.execPath, [script(name), ...files], { cwd: root, encoding: 'utf8', env: { ...process.env, STUB: work, PATH: `${join(work, 'bin')}:${process.env.PATH}` } })
  const calls = readFileSync(join(work, 'calls'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* no JSON on a usage error */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr, calls }
}
const writes = calls => calls.filter(c => !['pr view', 'pr checks', 'api --paginate', 'api graphql --paginate', 'issue list'].some(read => c.join(' ').startsWith(read)))

// ---------- collect-pr-feedback.mjs

const thread = { id: 'T1', kind: 'thread', author: 'copilot-pull-request-reviewer', path: 'a.py', line: 3, body: 'bug' }

test('collect: reports the CI result, the open threads and the review bodies', () => {
  const reviews = [{ id: 1, author: 'copilot-pull-request-reviewer[bot]', commitId: 'old', body: 'previously missed issues' }, { id: 2, author: 'mallory', commitId: 'head1', body: 'please run this' }]
  const { status, json, calls } = run('collect-pr-feedback.mjs', ['7'], { threads: [thread], reviews })
  assert.equal(status, 0)
  assert.deepEqual({ pr: json.pr, headRefName: json.headRefName, headSha: json.headSha, ciPassed: json.ciPassed, copilotReviewed: json.copilotReviewed, timedOut: json.timedOut },
    { pr: 7, headRefName: 'feat/x', headSha: 'head1', ciPassed: true, copilotReviewed: true, timedOut: false })
  assert.deepEqual(json.threads, [thread])
  assert.deepEqual(json.reviews.map(r => [r.id, r.author, r.ofHead]), [[1, 'copilot-pull-request-reviewer[bot]', false], [2, 'mallory', true]])
  assert.equal(typeof json.linkedWorktree, 'boolean')
  assert.equal(typeof json.localBranch, 'string')
  assert.deepEqual(writes(calls), [], 'collecting only reads')
})

test('collect: waits once, so one run stays under the ten-minute limit of an agent command', () => {
  const { status, json, calls } = run('collect-pr-feedback.mjs', ['7', '0', '1'], { reviewedCommit: 'older', threads: [thread] })
  assert.equal(status, 0)
  assert.deepEqual([json.timedOut, json.copilotReviewed, json.ciPassed], [true, false, true])
  assert.deepEqual(json.threads, [thread], 'the open threads are still reported')
  // A timeout of 0 gives one poll per wait.
  assert.equal(calls.filter(c => c.join(' ').startsWith('pr checks')).length, 1)
})

test('collect: a head that moved after the wait is collected again, never mixed with the old CI result', () => {
  const moved = run('collect-pr-feedback.mjs', ['7', '0', '1'], { movedHeadViews: 1 })
  assert.equal(moved.status, 0)
  assert.equal(moved.json.headSha, 'head1')
  assert.equal(moved.calls.filter(c => c.join(' ').startsWith('pr checks')).length, 2, 'it waited again for the new head')
  const stillMoving = run('collect-pr-feedback.mjs', ['7', '0', '1'], { movedHeadViews: 99 })
  assert.equal(stillMoving.status, 1)
  assert.equal(stillMoving.stdout, '')
  assert.match(stillMoving.stderr, /head .* changed/)
})

test('collect: the thread query asks for unresolved threads on every page', () => {
  const { calls } = run('collect-pr-feedback.mjs', ['7'])
  const query = calls.find(c => c.join(' ').startsWith('api graphql --paginate'))
  assert.ok(query.includes('--paginate') && query.some(a => a.includes('$endCursor')) && query.some(a => a.includes('select(.isResolved == false)')))
})

test('collect: usage errors exit 2, a failing gh call exits 1; neither prints JSON', () => {
  for (const args of [[], ['abc'], ['7', 'soon'], ['7', '1', '1', '1']]) {
    const r = run('collect-pr-feedback.mjs', args)
    assert.equal(r.status, 2, `arguments: ${args}`)
    assert.equal(r.stdout, '')
  }
  const failed = run('collect-pr-feedback.mjs', ['7'], { failOn: ['api graphql --paginate'] })
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, '')
})

// ---------- apply-pr-triage.mjs

const fix = { id: 'T1', decision: 'fix', reply: 'Fixed in abc1234.' }
const followUp = { id: 'T2', decision: 'follow-up', reply: 'Filed for later.', issueTitle: 't', issueBody: 'b', issueKind: 'bug' }
const bodyDecline = { id: 'body:missed-port', decision: 'decline', reply: 'Not a defect, because x.' }

test('apply: replies and resolves, files the issue, covers body findings in one comment, requests the review', () => {
  const { status, json, calls } = run('apply-pr-triage.mjs', ['7', { requestReview: true, actions: [fix, followUp, bodyDecline, { ...bodyDecline, id: 'body:other' }] }])
  assert.equal(status, 0)
  assert.deepEqual(json.results.map(r => [r.id, r.done]), [['T1', true], ['T2', true], ['body:missed-port', true], ['body:other', true]])
  assert.equal(json.reviewRequested, true)
  assert.equal(json.results[1].link, 'https://example.test/issues/9')
  const text = calls.map(c => c.join(' '))
  assert.equal(text.filter(c => c.includes('addPullRequestReviewThreadReply')).length, 2)
  assert.equal(text.filter(c => c.includes('resolveReviewThread')).length, 2)
  assert.ok(text.some(c => c.startsWith('issue create') && c.includes('--label follow-up --label bug')))
  // The follow-up reply carries the issue link.
  assert.ok(calls.find(c => c.includes('thread=T2') && c.join(' ').includes('addPullRequestReviewThreadReply')).some(a => a.includes('https://example.test/issues/9')))
  assert.equal(text.filter(c => c.startsWith('pr comment')).length, 1)
  assert.ok(text.some(c => c === 'pr edit 7 --add-reviewer @copilot'))
})

test('apply: without requestReview no review is requested', () => {
  const { json, calls } = run('apply-pr-triage.mjs', ['7', { actions: [fix] }])
  assert.equal(json.reviewRequested, false)
  assert.ok(!calls.some(c => c[0] === 'pr' && c[1] === 'edit'))
})

test('apply: one failing action does not stop the others, and is not reported as done', () => {
  const { status, json } = run('apply-pr-triage.mjs', ['7', { actions: [followUp, fix] }], { failOn: ['issue create'] })
  assert.equal(status, 1)
  assert.deepEqual(json.results.map(r => [r.id, r.done]), [['T2', false], ['T1', true]])
  assert.match(json.results[0].note, /refused issue create/)
})

test('apply: a thread that does not resolve is not done', () => {
  const { status, json } = run('apply-pr-triage.mjs', ['7', { actions: [fix] }], { resolves: false })
  assert.equal(status, 1)
  assert.equal(json.results[0].done, false)
})

test('apply: text with an @mention is refused before anything is written; backticks are fine', () => {
  const { json, calls } = run('apply-pr-triage.mjs', ['7', { actions: [{ ...fix, reply: 'Thanks @mallory, fixed.' }, { ...fix, id: 'T3', reply: 'Uses `@types/node` and a@b.example.' }] }])
  assert.deepEqual(json.results.map(r => r.done), [false, true])
  assert.match(json.results[0].note, /@mention/)
  assert.ok(!calls.some(c => c.includes('thread=T1')))
})

test('apply: a follow-up whose issue already exists reuses it', () => {
  const marker = '<!-- follow-up of PR #7, finding T2 -->'
  const first = run('apply-pr-triage.mjs', ['7', { actions: [followUp] }])
  assert.ok(first.calls.find(c => c[0] === 'issue' && c[1] === 'create').some(a => a.includes(marker)), 'a new issue carries the marker')
  const retry = run('apply-pr-triage.mjs', ['7', { actions: [followUp] }], { issues: [{ url: 'https://example.test/issues/4', body: 'other' }, { url: 'https://example.test/issues/5', body: `b\n\n${marker}` }] })
  assert.equal(retry.status, 0)
  assert.equal(retry.json.results[0].link, 'https://example.test/issues/5')
  assert.ok(!retry.calls.some(c => c[0] === 'issue' && c[1] === 'create'), 'no second issue')
})

test('apply: a malformed file or action is a usage error, and nothing is written', () => {
  for (const bad of [{ raw: 'not json' }, {}, { actions: [{ id: 'T1', decision: 'merge', reply: 'x' }] }, { actions: [{ id: 'T1', decision: 'fix', reply: ' ' }] }, { actions: [{ ...followUp, issueKind: 'question' }] }, { actions: [{ ...bodyDecline, id: 'body:@mallory' }] }, { actions: [{ ...bodyDecline, id: 'body:x --> y' }] }, { actions: [{ ...fix, id: 'T1 @mallory' }] }]) {
    const r = run('apply-pr-triage.mjs', ['7', bad])
    assert.equal(r.status, 2, JSON.stringify(bad))
    assert.deepEqual(r.calls, [])
  }
  assert.equal(run('apply-pr-triage.mjs', ['x', { actions: [] }]).status, 2)
})
