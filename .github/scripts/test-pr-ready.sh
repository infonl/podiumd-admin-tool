#!/usr/bin/env bash
# Tests for pr-ready.sh. Puts a stub `gh` first on PATH that answers from
# environment variables, and asserts the exit status and the verdict line.
#
# Usage: .github/scripts/test-pr-ready.sh   (exits non-zero on a failure)
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-ready.sh"
work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
failures=0

mkdir -p "${work}/bin"
cat >"${work}/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view") echo "${DRAFT} head1 ${STATE}" ;;
  "pr checks") echo "${CHECKS}" ;;
  "api --paginate") printf 'older\n%s\n' "${REVIEWED}" ;;
  "api graphql") echo "${UNRESOLVED}" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 64 ;;
esac
STUB
chmod +x "${work}/bin/gh"

# expect <name> <status> <verdict fragment> VAR=value...
expect() {
  local name=$1 want=$2 fragment=$3 out status=0
  shift 3
  out=$(env DRAFT=false STATE=OPEN CHECKS="6 " REVIEWED=head1 UNRESOLVED=0 "$@" PATH="${work}/bin:${PATH}" "${script}" 7 2>&1) || status=$?
  if [[ $status -eq $want && $out == *"$fragment"* ]]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name} (status ${status}, want ${want})"
    printf '%s\n' "${out}" | sed 's/^/       /'
    failures=$((failures + 1))
  fi
}

expect "everything green is ready" 0 "READY  #7"
expect "a draft is not ready" 1 "draft"  DRAFT=true
expect "a merged pull request is not ready" 1 "MERGED"  STATE=MERGED
expect "a failing required check is not ready" 1 "backend=fail"  CHECKS="6 backend=fail"
expect "no required checks yet is not ready" 1 "no required checks"  CHECKS="0 "
expect "a Copilot review of an older commit is not ready" 1 "not of the head"  REVIEWED=old1
expect "no Copilot review is not ready" 1 "no Copilot review"  REVIEWED=
expect "an unresolved thread is not ready" 1 "1 unresolved"  UNRESOLVED=1
# Usage error: call without a valid PR number.
status=0; PATH="${work}/bin:${PATH}" "${script}" abc >/dev/null 2>&1 || status=$?
if [[ $status -eq 2 ]]; then echo "ok   a non-numeric PR exits 2"; else echo "FAIL a non-numeric PR exits 2 (got ${status})"; failures=$((failures + 1)); fi

if [[ $failures -gt 0 ]]; then
  echo "${failures} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
