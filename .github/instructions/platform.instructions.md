---
applyTo: ".github/**,charts/**,Dockerfile,dev/**"
---

# Platform review focus

- **Required checks** (`backend`, `frontend`, `image`, `hygiene`, `CodeQL (python)`, `CodeQL (javascript-typescript)`, and new ones such as `chart`) must report on **every** pull request. They are gated through the `changes` job; a job that never starts leaves a pull request stuck on "Expected".
- **Fail open.** A detection step that fails or cannot decide must lead to the check running, never to a skip.
- **Workflow security.** Least-privilege `permissions`, `persist-credentials: false`, no `pull_request_target`, no `${{ }}` with untrusted values inside `run:`, every action pinned to a full commit SHA.
- **Shared resources.** Local check scripts can run in parallel git worktrees on one Docker daemon. Image tags, container names, ports and temp files must be unique per run.
- **Helm chart.** Application settings live under `settings:` and are strictly validated (`additionalProperties: false`). Common Kubernetes values and `extraEnvVars`, `extraVolumes` and `extraVolumeMounts` are allowed, but `extraEnvVars` must not set `PODIUMD_ADMIN_*`. Secrets come only from existing Secrets. RBAC stays namespace-scoped, with no `pods/exec` and no `list`/`watch` on Secrets. The pod security context stays hardened (non-root, read-only root filesystem, no privilege escalation, all capabilities dropped).
- **Dependabot** must still be able to update every pin and digest; flag settings that would break its updates.
