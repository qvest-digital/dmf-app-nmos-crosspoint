#!/bin/sh
# Fails when the version in Chart.yaml is already in the registry, so a
# chart change cannot be published over an existing version. Run from the
# repository root, by CI on pull requests and by chart-publish.yml before it
# pushes. The package is public, so no login is needed.
set -eu

chart=charts/nmos-crosspoint
repository=${GITHUB_REPOSITORY:-qvest-digital/dmf-app-nmos-crosspoint}
ref="oci://ghcr.io/$repository/charts/nmos-crosspoint"
version=$(sed -n 's/^version: *//p' "$chart/Chart.yaml")
[ -n "$version" ] || {
  echo "FAIL: no version in $chart/Chart.yaml" >&2
  exit 1
}

if out=$(helm show chart "$ref" --version "$version" 2>&1); then
  echo "FAIL: nmos-crosspoint $version is already published; raise the version in $chart/Chart.yaml" >&2
  exit 1
fi
case $out in
*"not found"*) echo "nmos-crosspoint $version is not published yet" ;;
*)
  echo "$out" >&2
  echo "FAIL: could not tell whether nmos-crosspoint $version is published" >&2
  exit 1
  ;;
esac
