# Review instructions for the PodiumD Admin Tool

The PodiumD Admin Tool is a web app for municipality admins. It is installed once per PodiumD Environment (`test`, `accp`, `prod`), in that Environment's own Kubernetes namespace. It shows Effective Settings, runs Scripts as one-off Kubernetes Jobs, runs read-only diagnostic Checks, and keeps an append-only Audit Log. The backend is Python 3.12 with FastAPI; the frontend is React with TypeScript; it ships with a Helm chart. This repository is public.

## What to focus on

Report every relevant problem **in the first review**, including problems in unchanged code that the change depends on, rather than spreading them over several rounds. Rank findings by impact. Prioritise:

1. **Concurrency.** Two requests on the same Session or row at the same time: check-then-act gaps, an update or delete of a row read earlier without a condition, writing back a whole row that was read earlier, locks held during I/O. This has been the most common defect here.
2. **Security.** Secrets in logs, Audit Entries or responses. Missing authorisation on an endpoint (`require(permission)`). CSRF on state-changing requests. Open redirects. Trusting proxy headers outside `trustedProxies`. Untrusted input in shell or workflow `run:` blocks. RBAC wider than the PodiumD namespace, or any `pods/exec` or listing of Secrets.
3. **The Audit Log guarantees** (design D4): an action takes effect only after its Audit Entry is stored. Entries are never updated or deleted. The stdout copy appears only for entries that were stored. Failures are reported without masking the original error.
4. **Failure paths.** The database unavailable, an aborted or rolled-back transaction, a failing external call (Keycloak), a failing log sink.
5. **Time and input.** Backward clock steps, monotonic values, boundary operators; empty, malformed, non-ASCII, IPv6 and quoted input.
6. **Spec deviations.** Behaviour that contradicts `openspec/changes/*/specs/` or the ADRs in `docs/adr/`.
7. **Drift.** A new CI area, required check, setting or route that is not listed everywhere it must be: `ci.yml`, `.github/scripts/changed-areas.sh` and its tests, the README path-gate table, `check.sh`, `CLAUDE.md`, `.claude/agents/`.

## Conventions to respect (don't flag these)

- **Hexagonal backend** (ADR 0009): `domain/`, `application/` and `ports/` never import FastAPI, SQLAlchemy, psycopg, Alembic or Authlib. import-linter enforces this.
- **Terms** come from `CONTEXT.md` (Environment, Component, Script, Script Run, Audit Entry, Viewer, Operator, ...).
- **Test data** uses the fictional municipality **Onsdorp** and `onsdorp.example`. `@utrecht/component-library-css` and the `utrecht-*` CSS classes are the NL Design System package, not a municipality.
- **Tool versions** have one source each (README "Tool versions"). A version is never repeated in a workflow, Dockerfile or doc command. GitHub Actions and hooks are pinned to commit SHAs, and images to digests.
- **Path-gated CI:** a skipped required job counts as passing. `on.paths` is deliberately not used.
- **The OIDC sign-in start and callback are GET requests** (standard Authorization Code flow with PKCE). They are protected by the single-use `state` bound to the `__Host-` sign-in cookie, not by the CSRF header.
- The UI text is Dutch through react-i18next; code, comments and docs are English.
- `openapi.json` is generated at build time, and `docs/research/` is reference material.
