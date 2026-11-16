#!/usr/bin/env node
// Apply the triage of review findings to a pull request: reply in each thread
// and resolve it, file the follow-up issues, cover the findings without a
// thread in one PR comment, and ask Copilot to review again.
//
// Usage:
//   apply-pr-triage.mjs PR FILE
//
// FILE is JSON:
//
//   {"requestReview": true,
//    "actions": [
//      {"id":"PRRT_...","decision":"fix","reply":"Fixed in abc1234. ..."},
//      {"id":"PRRT_...","decision":"follow-up","reply":"...","issueTitle":"...","issueBody":"...","issueKind":"bug"},
//      {"id":"body:short-slug","decision":"decline","reply":"..."}]}
//
// decision is fix, follow-up or decline. An id that starts with "body:" is a
// finding without a thread. issueKind is bug or enhancement. Pushing is not
// done here: push first, so a reply can name a commit that is on the branch.
//
// It writes to GitHub with an authenticated gh, and prints one JSON object:
//
//   {"results":[{"id":"...","done":true,"link":"<issue or comment URL>","note":""}],
//    "reviewRequested":true,"summary":"3 of 3 done"}
//
// done is true only when the reply or comment exists, the issue exists (for a
// follow-up) and the thread is resolved. One failing action does not stop the
// others. Text with an @mention is refused: it would notify the named account.
//
// Exits 2 on a usage error or an unreadable FILE, and 1 when anything was not done.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const usage = message => {
  console.error(`${message}\nusage: apply-pr-triage.mjs PR FILE`)
  process.exit(2)
}
const [pr, file, ...rest] = process.argv.slice(2)
if (!/^[0-9]+$/.test(pr ?? '') || !file || rest.length) usage('wrong arguments')

let input
try {
  input = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  usage(`cannot read ${file}: ${error.message}`)
}
const DECISIONS = ['fix', 'follow-up', 'decline']
const actions = input.actions
if (!Array.isArray(actions)) usage('"actions" must be an array')
for (const a of actions) {
  if (typeof a.id !== 'string' || !a.id) usage('every action needs an id')
  if (!DECISIONS.includes(a.decision)) usage(`${a.id}: decision must be one of ${DECISIONS.join(', ')}`)
  if (typeof a.reply !== 'string' || !a.reply.trim()) usage(`${a.id}: reply is empty`)
  if (a.decision === 'follow-up' && !(a.issueTitle && a.issueBody && ['bug', 'enhancement'].includes(a.issueKind))) usage(`${a.id}: a follow-up needs issueTitle, issueBody and issueKind (bug or enhancement)`)
}

const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const failure = error => String(error.stderr || error.message).trim().split('\n')[0]
// A bare @name notifies that account. Names in backticks do not.
const mentions = text => /(^|[^`\w])@[A-Za-z0-9][A-Za-z0-9-]*/.test(String(text ?? '').replace(/`[^`]*`/g, ''))

const results = []
const withoutThread = []
for (const a of actions) {
  const result = { id: a.id, done: false, link: '', note: '' }
  results.push(result)
  try {
    if ([a.reply, a.issueTitle, a.issueBody].some(mentions)) throw new Error('the text holds an @mention; put the name in backticks')
    let reply = a.reply
    if (a.decision === 'follow-up') {
      result.link = gh(['issue', 'create', '--title', a.issueTitle, '--body', a.issueBody, '--label', 'follow-up', '--label', a.issueKind]).split('\n').pop()
      reply = `${reply}\n\nFollow-up: ${result.link}`
    }
    if (a.id.startsWith('body:')) {
      withoutThread.push({ result, reply })
      continue
    }
    const comment = gh(['api', 'graphql', '-f', 'query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}',
      '-f', `thread=${a.id}`, '-f', `body=${reply}`, '--jq', '.data.addPullRequestReviewThreadReply.comment.url'])
    result.link ||= comment
    const resolved = gh(['api', 'graphql', '-f', 'query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}',
      '-f', `thread=${a.id}`, '--jq', '.data.resolveReviewThread.thread.isResolved'])
    if (resolved !== 'true') throw new Error('replied, but the thread is not resolved')
    result.done = true
  } catch (error) {
    result.note = failure(error)
  }
}

// Findings without a thread share one comment.
if (withoutThread.length) {
  try {
    const url = gh(['pr', 'comment', pr, '--body', withoutThread.map(({ result, reply }) => `**${result.id.slice('body:'.length)}**\n\n${reply}`).join('\n\n---\n\n')]).split('\n').pop()
    for (const { result } of withoutThread) {
      result.link ||= url
      result.done = true
    }
  } catch (error) {
    for (const { result } of withoutThread) result.note = failure(error)
  }
}

let reviewRequested = false
let reviewNote = ''
if (input.requestReview === true) {
  try {
    gh(['pr', 'edit', pr, '--add-reviewer', '@copilot'])
    reviewRequested = true
  } catch (error) {
    reviewNote = `; the Copilot review was not requested: ${failure(error)}`
  }
}

const done = results.filter(r => r.done).length
console.log(JSON.stringify({ results, reviewRequested, summary: `${done} of ${results.length} done${reviewNote}` }))
process.exit(done === results.length && !reviewNote ? 0 : 1)
