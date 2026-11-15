# Review lessons

Defects that slipped past the developer and were caught later by the
code-reviewer or the Copilot review, with the check that would have caught
them earlier. Every developer role and the code-reviewer read this file before
they start. When the code-reviewer triages a review finding as **fix**, the
task-manager adds one line here in the same push.

Format: `- [area] What was missed (PR) → the check that catches it.`

## Concurrency and shared state

- [backend] An expiry sweep deleted a session that a request had just touched: the sweep read the batch, then deleted by id without a condition (#51). → Every delete or update of a row that was read earlier is conditional (`WHERE` on the value that was checked, e.g. `last_seen_at`), and a test interleaves the two operations.
- [backend] A request wrote back the whole session it had read at the start, overwriting the tokens and roles a parallel request had just refreshed (#51). → Never write back a full row read earlier; update only the fields this request changed, conditionally, and test with two interleaved requests.
- [backend] The failure aggregator held its lock while writing to stdout, serialising all callers (#12). → Collect under the lock, do I/O after releasing it.
- [backend] Every event scanned all aggregation windows: O(n) on the hot path (#12). → Check the cost per event of every data structure on a request path.
- [platform] `check.sh image` used one fixed Docker tag, so parallel worktrees could smoke-test and scan each other's image (#41). → Anything on a shared resource (Docker tags, ports, caches, temp names) is unique per run and cleaned up.
- [platform] `check.sh chart` mounted one fixed named Docker volume as the kubeconform schema cache, so parallel worktrees could read each other's half-written files (#58). → Every Docker volume, tag and temp name a check creates is unique per run and removed on success, failure and interrupt.

## Failure paths

- [backend] After an explicit rollback, the stdout audit copy was still written for entries that were never stored (#27). → Test each audit path with the transaction rolled back, aborted, and committed.
- [backend] When storing an Audit Entry failed and the stdout report failed too, the wrong error escaped (#13). → Test the failure path of the failure handling.
- [workflow] A failing step dropped everything the run had collected (#28, #31). → Every early exit keeps and reports the state collected so far.

## Input and time

- [platform] Quoted (non-ASCII) paths from `git diff` matched no area, so the path gate skipped checks (#26). → Read raw paths (`-z`, `core.quotePath=false`) and test non-ASCII, quotes and backslashes.
- [backend] The local-issuer check mangled IPv6 hosts such as `[::1]` (#34). → Test IPv4, IPv6 and host names for every address or URL parsing.
- [backend] A malformed `X-Forwarded-For` header could cause a 500 (#34). → Every header from a request falls back safely when it is malformed.
- [backend] A backward clock step could make `last_at` earlier than `first_at` and lose counted failures (#14). → Time values that must not go backwards are kept monotonic, and a test steps the clock back.
- [platform] The chart accepted an idle timeout longer than the session lifetime, which the backend refuses at startup (#58). → A constraint between two settings is checked in the chart with a template-time `fail` (JSON Schema cannot compare fields), with a test on each side of the boundary.

## Consistency and drift

- [platform] Adding a CI area (`image`, `chart`) needed hand-written changes in CLAUDE.md, three role files and the README table, and some were missed (#41, #48). → Follow the platform-engineer's touchpoint list; the consistency tests in `.claude/tests/repo-consistency.test.mjs` fail on drift.
- [platform] `engine-strict` would have broken every Dependabot npm update (#26). → For every pin or strictness setting, check that Dependabot can still update it.
- [platform] Chart selectors matched the migration Job pod because the selector labels were a subset of the shared labels, so the PodDisruptionBudget selected a Job-owned pod (#58). → Give each workload its own selector label (e.g. `component`), and test that no other pod template satisfies a selector.
- [platform] The PodDisruptionBudget rendered both `minAvailable` and `maxUnavailable` when only one was set, which the Kubernetes API rejects (#58). → For mutually exclusive chart values, test each combination, including a zero value, against the rendered manifest.
- [all] An implementation followed the standard OIDC flow (GET callback) while the spec said actions are never GET; it was only found in review (#51). → Pre-flight: read the spec requirement and scenarios of each task before building, and report conflicts as a decision first.
- [all] A commit message gave the wrong reason for a version pin (#26). → Claims in commit messages say what was verified.
