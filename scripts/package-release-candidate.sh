#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/release-contract.sh"

INPUT_DIR=""
OUTPUT_DIR=""
VERSION=""
SOURCE_SHA=""
REPOSITORY=""
RUN_ID=""

usage() {
  cat <<'USAGE'
Usage: bash scripts/package-release-candidate.sh \
  --input DIR --output DIR --version vX.Y.Z --sha FULL_SHA \
  --repository OWNER/REPO --run-id ID
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT_DIR="${2:-}"; shift 2 ;;
    --output) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha) SOURCE_SHA="${2:-}"; shift 2 ;;
    --repository) REPOSITORY="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown release candidate packaging argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -d "$INPUT_DIR" ]] || { echo "candidate artifact input directory does not exist: $INPUT_DIR" >&2; exit 1; }
[[ -n "$OUTPUT_DIR" ]] || { echo "candidate output directory is required" >&2; exit 64; }
[[ -n "$REPOSITORY" ]] || { echo "candidate repository is required" >&2; exit 64; }
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || { echo "candidate workflow run ID must be numeric" >&2; exit 64; }
require_release_version "$VERSION"
require_full_git_sha "$SOURCE_SHA"
command -v jq >/dev/null 2>&1 || { echo "candidate packaging requires jq" >&2; exit 1; }

assets=(
  pocketctl_darwin_amd64
  pocketctl_darwin_arm64
  pocketctl_linux_amd64
  pocketctl_linux_arm64
  pocketctl_windows_amd64.exe
  pocketctl_windows_arm64.exe
)
source_paths=()

for asset in "${assets[@]}"; do
  matches=()
  while IFS= read -r -d '' match; do
    matches+=("$match")
  done < <(find "$INPUT_DIR" -type f -name "$asset" -print0)
  [[ ${#matches[@]} -eq 1 ]] || {
    echo "candidate requires exactly one $asset; found ${#matches[@]}" >&2
    exit 1
  }
  source_paths+=("${matches[0]}")
done

while IFS= read -r -d '' candidate_file; do
  candidate_name=$(basename "$candidate_file")
  known=false
  for asset in "${assets[@]}"; do
    if [[ "$candidate_name" == "$asset" ]]; then
      known=true
      break
    fi
  done
  [[ "$known" == true ]] || {
    echo "unexpected candidate binary: $candidate_name" >&2
    exit 1
  }
done < <(find "$INPUT_DIR" -type f -name 'pocketctl_*' -print0)

if [[ -e "$OUTPUT_DIR" ]] && [[ -n "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "candidate output directory must be empty: $OUTPUT_DIR" >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR"

assets_json='[]'
for index in 0 1 2 3 4 5; do
  asset="${assets[$index]}"
  source_path="${source_paths[$index]}"
  destination="$OUTPUT_DIR/$asset"
  cp -p "$source_path" "$destination"
  checksum=$(shasum -a 256 "$destination" | awk '{print $1}')
  printf '%s\n' "$checksum" > "$destination.sha256"
  size=$(wc -c < "$destination" | tr -d ' ')
  assets_json=$(jq -c \
    --arg name "$asset" \
    --arg sha256 "$checksum" \
    --argjson size "$size" \
    '. + [{name: $name, sha256: $sha256, size: $size}]' \
    <<< "$assets_json")
done

manifest="$OUTPUT_DIR/release-candidate-manifest.json"
jq -n \
  --arg version "$VERSION" \
  --arg source_sha "$SOURCE_SHA" \
  --arg repository "$REPOSITORY" \
  --arg workflow_run_id "$RUN_ID" \
  --argjson assets "$assets_json" \
  '{
    schema_version: 1,
    version: $version,
    source_sha: $source_sha,
    repository: $repository,
    workflow_run_id: $workflow_run_id,
    assets: $assets
  }' > "$manifest"

echo "release candidate bundle prepared: $OUTPUT_DIR"
