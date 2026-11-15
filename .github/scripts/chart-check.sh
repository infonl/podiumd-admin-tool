#!/usr/bin/env bash
# The checks of the Helm chart charts/podiumd-admin (task 11.5).
#
# Usage: chart-check.sh lint|unittest|kubeconform
#
#   lint         `helm lint --strict` with each test values file
#   unittest     `helm unittest` (charts/podiumd-admin/tests/*_test.yaml)
#   kubeconform  `helm template` for every supported Kubernetes version, with
#                each test values file, validated by `kubeconform -strict`
#
# The tools run as the images pinned in .github/tools/helm-unittest/Dockerfile
# (Helm and helm-unittest) and .github/tools/kubeconform/Dockerfile, their
# single version sources, so CI and local runs use the same tools. The Helm
# containers get the chart read-only and no network. kubeconform downloads
# the Kubernetes and CRD JSON schemas, from the commits pinned below, into a
# Docker volume of its own for each run, which is removed afterwards: parallel
# runs on one Docker daemon never share a half-written schema.
#
# The supported Kubernetes versions are listed in
# charts/podiumd-admin/tests/kubernetes-versions; `helm template --kube-version`
# also fails when a listed version is outside the chart's kubeVersion.
#
# Needs Docker.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 lint|unittest|kubeconform" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
chart_dir="${root}/charts/podiumd-admin"
values_files=(onsdorp.yaml all-features.yaml)

# The Kubernetes JSON schemas (yannh/kubernetes-json-schema) and the CRD
# schemas for the Gateway API HTTPRoute (datreeio/CRDs-catalog), pinned to a
# commit so a run is reproducible. Bump the commits by hand when a newly
# supported Kubernetes version needs newer schemas.
k8s_schemas='https://raw.githubusercontent.com/yannh/kubernetes-json-schema/2bfaff3898a7a4fa4e4760da3d2656211c9b4c71/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json'
crd_schemas='https://raw.githubusercontent.com/datreeio/CRDs-catalog/89c736bdde38b5fecd0f8436ec5f3aa3679a3b86/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

# pinned_image <tool>: the digest-pinned FROM image in .github/tools/<tool>/Dockerfile.
pinned_image() {
  local image
  image=$(awk 'toupper($1) == "FROM" { print $2; exit }' "${root}/.github/tools/$1/Dockerfile")
  if [[ ! ${image} =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "no digest-pinned FROM image in .github/tools/$1/Dockerfile" >&2
    exit 1
  fi
  echo "${image}"
}

helm_image=$(pinned_image helm-unittest)
kubeconform_image=$(pinned_image kubeconform)

# in_helm_image <entrypoint> <args...>: a command in the pinned Helm image,
# with the chart at /chart (read-only), a read-only root filesystem, a /tmp
# tmpfs, no network and no capabilities.
in_helm_image() {
  local entrypoint=$1
  shift
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env HELM_CACHE_HOME=/tmp/helm/cache \
    --env HELM_CONFIG_HOME=/tmp/helm/config \
    --volume "${chart_dir}:/chart:ro" \
    --workdir /chart \
    --entrypoint "${entrypoint}" \
    "${helm_image}" \
    "$@"
}

helm_run() {
  in_helm_image helm "$@"
}

run_lint() {
  local values
  for values in "${values_files[@]}"; do
    echo "helm lint --strict (tests/values/${values}) with ${helm_image}" >&2
    helm_run lint --strict --values "tests/values/${values}" .
  done
}

run_unittest() {
  echo "helm unittest with ${helm_image}" >&2
  # helm-unittest always creates tests/__snapshot__, so it runs on a copy of
  # the read-only chart in /tmp.
  in_helm_image sh -c 'cp -R /chart /tmp/chart && exec helm unittest --strict /tmp/chart'
}

# The temp file and the cache volume of run_kubeconform, removed on exit.
kubeconform_manifests=''
kubeconform_cache_volume=''
kubeconform_cleanup() {
  if [[ -n ${kubeconform_manifests} ]]; then
    rm -f "${kubeconform_manifests}"
  fi
  if [[ -n ${kubeconform_cache_volume} ]]; then
    docker volume rm -f "${kubeconform_cache_volume}" >/dev/null || true
  fi
}

run_kubeconform() {
  local version values
  local versions=()
  while IFS= read -r version; do
    version=${version%%#*}
    version=${version//[[:space:]]/}
    if [[ -n ${version} ]]; then
      versions+=("${version}")
    fi
  done <"${chart_dir}/tests/kubernetes-versions"
  if [[ ${#versions[@]} -eq 0 ]]; then
    echo "no Kubernetes versions in charts/podiumd-admin/tests/kubernetes-versions" >&2
    exit 1
  fi

  # The script exits after this function, so one EXIT trap cleans up after
  # a success, a failure under set -e and an interrupt.
  trap kubeconform_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  kubeconform_manifests=$(mktemp)
  # A volume per run: parallel runs on one Docker daemon do not share it.
  kubeconform_cache_volume="podiumd-admin-kubeconform-cache-$$-${RANDOM}${RANDOM}"
  docker volume create "${kubeconform_cache_volume}" >/dev/null
  for version in "${versions[@]}"; do
    for values in "${values_files[@]}"; do
      echo "Kubernetes ${version}, tests/values/${values}: helm template | kubeconform (${kubeconform_image})" >&2
      helm_run template podiumd-admin . \
        --namespace podiumd \
        --kube-version "${version}" \
        --values "tests/values/${values}" >"${kubeconform_manifests}"
      docker run --rm -i \
        --read-only \
        --cap-drop ALL \
        --security-opt no-new-privileges \
        --volume "${kubeconform_cache_volume}:/cache" \
        "${kubeconform_image}" \
        -strict \
        -summary \
        -kubernetes-version "${version}" \
        -cache /cache \
        -schema-location "${k8s_schemas}" \
        -schema-location "${crd_schemas}" \
        - <"${kubeconform_manifests}"
    done
  done
}

case $1 in
  lint) run_lint ;;
  unittest) run_unittest ;;
  kubeconform) run_kubeconform ;;
  *)
    echo "usage: $0 lint|unittest|kubeconform" >&2
    exit 2
    ;;
esac
