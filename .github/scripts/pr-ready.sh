#!/usr/bin/env bash
# Is a pull request ready for the user to merge? Checks, for the current head
# commit: not a draft, every required check passed or was skipped, the Copilot
# review of the head commit has been submitted, and no review thread is unresolved.
#
# Usage:
#   pr-ready.sh PR
#
# Prints one line per condition and a verdict. Exits 0 when the pull request is
# ready, 1 when it is not, and 2 on a usage error or a failing gh call. Needs an
# authenticated gh in a checkout of the repository. Read-only.
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "usage: $0 PR" >&2
  exit 2
fi
pr=$1
ready=true

report() { # report <ok|not> <text>
  if [[ $1 == ok ]]; then
    echo "ok   $2"
  else
    echo "NOT  $2"
    ready=false
  fi
}

view=$(gh pr view "$pr" --json isDraft,headRefOid,state --jq '"\(.isDraft) \(.headRefOid) \(.state)"') || exit 2
read -r draft head state <<<"$view"

if [[ $state != OPEN ]]; then report not "pull request is ${state}, not OPEN"; else report ok "pull request is open"; fi
if [[ $draft == true ]]; then report not "pull request is a draft (Copilot does not review drafts)"; else report ok "pull request is not a draft"; fi

# Required checks: none pending, failed or cancelled; skipped counts as passing.
checks=$(gh pr checks "$pr" --required --json name,bucket --jq '{total: length, open: map(select(.bucket != "pass" and .bucket != "skipping")) | map("\(.name)=\(.bucket)")} | "\(.total) \(.open | join(","))"') || true
read -r total open_checks <<<"${checks:-0 }"
if [[ ${total:-0} -eq 0 ]]; then
  report not "no required checks reported yet"
elif [[ -n ${open_checks:-} ]]; then
  report not "required checks not green: ${open_checks}"
else
  report ok "all ${total} required checks passed or were skipped"
fi

# The latest Copilot review must be of the head commit (reviews come oldest first).
reviewed=$(gh api --paginate "repos/{owner}/{repo}/pulls/${pr}/reviews" --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | .commit_id' | tail -n 1) || exit 2
if [[ -z $reviewed ]]; then
  report not "no Copilot review yet"
elif [[ $reviewed != "$head" ]]; then
  report not "the latest Copilot review is of ${reviewed:0:7}, not of the head ${head:0:7}"
else
  report ok "Copilot reviewed the head ${head:0:7}"
fi

# Unresolved review threads on the pull request (every page).
# shellcheck disable=SC2016  # $owner, $name, $number and $endCursor are GraphQL variables for gh api, not shell expansions
unresolved=$(gh api graphql --paginate -F owner='{owner}' -F name='{repo}' -F number="$pr" \
  -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}' \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' | awk '{s+=$1} END {print s+0}') || exit 2
if [[ $unresolved -gt 0 ]]; then report not "${unresolved} unresolved review thread(s)"; else report ok "no unresolved review threads"; fi

if [[ $ready == true ]]; then
  echo "READY  #${pr} at ${head:0:7} can be merged"
  exit 0
fi
echo "NOT READY  #${pr} at ${head:0:7}"
exit 1
