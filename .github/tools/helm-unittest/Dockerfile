# The Helm and helm-unittest versions for the chart checks (task 11.5): the
# single source, read by .github/scripts/chart-check.sh in CI and locally. The
# tag is <helm version>-<helm-unittest version>; `helm lint`, `helm template`
# and `helm unittest` all run in this image, so they use the same Helm. It is a
# Dockerfile so that Dependabot (the docker ecosystem in .github/dependabot.yml)
# proposes updates to the tag and the digest together. Nothing is built from it.
FROM docker.io/helmunittest/helm-unittest:4.3.0-1.2.1@sha256:28ea86c3e0b07f501f0c2e9c08b9f41e240f4a4b571cb5106b36cf0f0607e989
