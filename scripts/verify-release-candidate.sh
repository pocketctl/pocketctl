#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/release-contract.sh"

INPUT_DIR=""
VERSION=""
SOURCE_SHA=""
REPOSITORY=""
RUN_ID=""

usage() {
  cat <<'USAGE'
Usage: bash scripts/verify-release-candidate.sh \
  --input DIR --version vX.Y.Z --sha FULL_SHA \
  --repository OWNER/REPO --run-id ID
USAGE
}

fail() {
  echo "release candidate verification failed: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT_DIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha) SOURCE_SHA="${2:-}"; shift 2 ;;
    --repository) REPOSITORY="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown release candidate verification argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -d "$INPUT_DIR" ]] || fail "input directory does not exist: $INPUT_DIR"
[[ -n "$REPOSITORY" ]] || fail "repository is required"
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail "workflow run ID must be numeric"
require_release_version "$VERSION"
require_full_git_sha "$SOURCE_SHA"
command -v jq >/dev/null 2>&1 || fail "jq is required"

assets=(
  pocketctl_darwin_amd64
  pocketctl_darwin_arm64
  pocketctl_linux_amd64
  pocketctl_linux_arm64
  pocketctl_windows_amd64.exe
  pocketctl_windows_arm64.exe
)
manifest="$INPUT_DIR/release-candidate-manifest.json"

# The promoted directory is a closed bundle: six binaries, six sidecars, and
# one manifest. Directories, symlinks, and extra files are rejected so a
# downloaded artifact cannot smuggle unverified release content.
actual_entries=$(find "$INPUT_DIR" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
[[ "$actual_entries" == 13 ]] || fail "bundle must contain exactly 13 top-level entries; found $actual_entries"
if find "$INPUT_DIR" -mindepth 1 \( ! -type f -o -type l \) -print -quit | grep -q .; then
  fail "bundle may contain only regular files"
fi
[[ -f "$manifest" && ! -L "$manifest" ]] || fail "manifest is missing or is not a regular file"

expected_names=$(mktemp)
actual_names=$(mktemp)
trap 'rm -f "$expected_names" "$actual_names"' EXIT
for asset in "${assets[@]}"; do
  printf '%s\n%s.sha256\n' "$asset" "$asset" >> "$expected_names"
done
printf '%s\n' release-candidate-manifest.json >> "$expected_names"
find "$INPUT_DIR" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | sort > "$actual_names"
sort -o "$expected_names" "$expected_names"
cmp -s "$expected_names" "$actual_names" || fail "bundle contains missing or unexpected files"

jq -e \
  --arg version "$VERSION" \
  --arg sha "$SOURCE_SHA" \
  --arg repository "$REPOSITORY" \
  --arg run_id "$RUN_ID" \
  'type == "object" and
   (keys | sort) == (["assets", "repository", "schema_version", "source_sha", "version", "workflow_run_id"] | sort) and
   .schema_version == 1 and
   .version == $version and
   .source_sha == $sha and
   .repository == $repository and
   .workflow_run_id == $run_id and
   (.assets | type == "array" and length == 6) and
   all(.assets[];
     type == "object" and
     (keys | sort) == (["name", "sha256", "size"] | sort) and
     (.name | type == "string") and
     (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
     (.size | type == "number" and . > 0 and floor == .)
   )' "$manifest" >/dev/null || fail "manifest schema or identity does not match the promotion request"

manifest_names=$(jq -r '.assets[].name' "$manifest" | sort)
expected_asset_names=$(printf '%s\n' "${assets[@]}" | sort)
[[ "$manifest_names" == "$expected_asset_names" ]] || fail "manifest asset names are incomplete or duplicated"

for asset in "${assets[@]}"; do
  binary="$INPUT_DIR/$asset"
  sidecar="$binary.sha256"
  [[ -f "$binary" && ! -L "$binary" ]] || fail "binary is missing or is not a regular file: $asset"
  [[ -f "$sidecar" && ! -L "$sidecar" ]] || fail "checksum is missing or is not a regular file: $asset.sha256"

  actual_sha=$(shasum -a 256 "$binary" | awk '{print $1}')
  actual_size=$(wc -c < "$binary" | tr -d ' ')
  manifest_sha=$(jq -r --arg name "$asset" '.assets[] | select(.name == $name) | .sha256' "$manifest")
  manifest_size=$(jq -r --arg name "$asset" '.assets[] | select(.name == $name) | .size' "$manifest")
  sidecar_sha=$(awk 'NF { print; count++ } END { if (count != 1) exit 1 }' "$sidecar") ||
    fail "checksum sidecar must contain exactly one non-empty line: $asset.sha256"

  [[ "$actual_sha" == "$manifest_sha" ]] || fail "manifest checksum mismatch: $asset"
  [[ "$actual_sha" == "$sidecar_sha" ]] || fail "checksum sidecar mismatch: $asset"
  [[ "$actual_size" == "$manifest_size" ]] || fail "manifest size mismatch: $asset"
done

echo "release candidate bundle verified: $VERSION at $SOURCE_SHA (run $RUN_ID)"
