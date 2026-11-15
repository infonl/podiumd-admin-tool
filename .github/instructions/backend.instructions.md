---
applyTo: 'backend/**'
---

# Backend review focus

- **Conditional writes.** For every SQL update or delete, check whether the row was read earlier in the same request or job. If it was, the statement must be conditional on what was checked (e.g. `WHERE id_hash = :id AND last_seen_at = :seen`) and the affected row count must be checked. Flag a write-back of a whole row read earlier.
- **Interleavings.** A Session can be used by parallel requests and by the expiry sweep at the same time. Ask for a test that interleaves them when the change touches session or audit state.
- **Audit Log.** Look for an action that can take effect without its Audit Entry, a path that writes the stdout copy for an entry that was not stored, or a reason code built from free text.
- **Time.** Time comes from the `Clock` port; `datetime.now()` in `domain/` or `application/` is a defect. Values such as `last_seen_at` must not go backwards.
- **Settings and requests.** Every setting and request header has a safe fallback or a clear startup error. A malformed value must never cause a 500.
- **Integration tests** run against real PostgreSQL and Keycloak through testcontainers, so don't suggest mocking those away.
