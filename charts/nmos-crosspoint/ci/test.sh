#!/bin/sh
# Rendering checks for the chart, run by CI from the repository root.
#
# - It renders with every required value set.
# - Without any one of them it fails, naming the value: an empty issuer,
#   host, registry or secret path renders a crosspoint that starts but can
#   neither log anybody in nor find a sender.
# - Every object lands in the release namespace.
# - The state volume survives deleting or renaming the release, since it
#   holds the saved connections.
set -eu

chart=charts/nmos-crosspoint
values=$chart/ci/test-values.yaml
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

helm template nmos-crosspoint "$chart" -f "$values" >/dev/null ||
  fail "the chart does not render with $values"

for key in keycloak.issuer keycloak.publicHost registry.ip adminPasswordSecretKey; do
  if out=$(helm template nmos-crosspoint "$chart" -f "$values" --set "$key=" 2>&1); then
    fail "the chart renders without $key"
  fi
  case $out in
  *"$key is required"*) ;;
  *) fail "rendering without $key does not name it: $out" ;;
  esac
done

out=$(helm template nmos-crosspoint "$chart" -f "$values" --namespace crosspoint-test)
# Object namespaces sit at two spaces under metadata; the HTTPRoute's
# parentRefs namespace is deeper and names the gateway's.
others=$(printf '%s\n' "$out" | grep '^  namespace:' | grep -v 'namespace: crosspoint-test$' || true)
[ -z "$others" ] || fail "objects outside the release namespace: $others"

printf '%s\n' "$out" |
  awk '/^kind: PersistentVolumeClaim$/ { pvc = 1 } /^---/ { pvc = 0 } pvc' |
  grep -q 'helm.sh/resource-policy: keep' ||
  fail "the state volume is not kept when the release goes"

echo "chart checks passed"
