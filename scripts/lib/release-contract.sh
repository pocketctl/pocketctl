#!/usr/bin/env bash

release_contract_error() {
  echo "release contract failed: $*" >&2
  return 1
}

require_clean_worktree() {
  local status
  status=$(git status --porcelain=v1 --untracked-files=all) || return 1
  [[ -z "$status" ]] || release_contract_error "worktree has staged, unstaged, or untracked changes"
}

classify_branch_sync() {
  local local_sha="$1"
  local remote_sha="$2"
  local merge_base="$3"

  if [[ "$local_sha" == "$remote_sha" ]]; then
    echo "equal"
  elif [[ "$merge_base" == "$remote_sha" ]]; then
    echo "local-ahead"
  elif [[ "$merge_base" == "$local_sha" ]]; then
    echo "remote-ahead"
  else
    echo "diverged"
  fi
}

require_release_version() {
  local version="${1:-}"
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ ]] ||
    release_contract_error "version '$version' must match vX.Y.Z or vX.Y.Z-rcN"
}

require_full_git_sha() {
  local sha="${1:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] ||
    release_contract_error "candidate SHA '$sha' must be a full lowercase 40-character Git SHA"
}

require_release_candidate_identity() {
  local candidate_sha="${1:-}"
  local version="${2:-}"
  local checkout_sha="${3:-}"
  local public_master_sha="${4:-}"
  local source_version="${5:-}"

  require_full_git_sha "$candidate_sha" || return 1
  require_release_version "$version" || return 1
  [[ "$checkout_sha" == "$candidate_sha" ]] ||
    release_contract_error "checked-out SHA '$checkout_sha' does not equal candidate '$candidate_sha'" || return 1
  [[ "$public_master_sha" == "$candidate_sha" ]] ||
    release_contract_error "public master SHA '$public_master_sha' does not equal candidate '$candidate_sha'" || return 1
  [[ "$source_version" == "${version#v}" ]] ||
    release_contract_error "source version '$source_version' does not equal candidate version '${version#v}'"
}

require_workflow_success() {
  local conclusion="${1:-}"
  [[ "$conclusion" == "success" ]] ||
    release_contract_error "GitHub release workflow conclusion is '${conclusion:-missing}', expected success"
}

# Revalidate a previously selected release-candidate run immediately before a
# tag is bound to it, and again inside the tag-triggered promotion workflow.
# The run identity and its single unexpired artifact must all match exactly.
require_github_release_candidate_run() (
  local repo="${1:-}"
  local run_id="${2:-}"
  local commit_sha="${3:-}"
  local version="${4:-}"
  local expected_title="Release candidate $version @ $commit_sha"
  local expected_artifact="release-candidate-$version-$commit_sha"
  local run_row database_id status conclusion head_sha display_title event workflow_name
  local artifact_rows artifact_id artifact_expired

  [[ -n "$repo" ]] || { release_contract_error "GitHub repository is required for release candidate validation"; return 1; }
  [[ "$run_id" =~ ^[0-9]+$ ]] || { release_contract_error "release candidate run ID must be numeric"; return 1; }
  require_full_git_sha "$commit_sha" || return 1
  require_release_version "$version" || return 1
  command -v gh >/dev/null 2>&1 || {
    release_contract_error "gh CLI is required to validate the GitHub release candidate"
    return 1
  }
  gh auth status >/dev/null 2>&1 || {
    release_contract_error "GitHub CLI authentication is required to validate the GitHub release candidate"
    return 1
  }

  run_row=$(gh run view "$run_id" \
    --repo "$repo" \
    --json databaseId,status,conclusion,headSha,displayTitle,event,workflowName \
    --jq '"\(.databaseId)\t\(.status)\t\(.conclusion // "")\t\(.headSha)\t\(.displayTitle)\t\(.event)\t\(.workflowName)"') || return 1
  IFS=$'\t' read -r database_id status conclusion head_sha display_title event workflow_name <<< "$run_row"

  [[ "$database_id" == "$run_id" ]] || {
    release_contract_error "release candidate returned run '$database_id', expected '$run_id'"
    return 1
  }
  [[ "$status" == "completed" ]] || {
    release_contract_error "release candidate run $run_id is '$status', expected completed"
    return 1
  }
  require_workflow_success "$conclusion" || return 1
  [[ "$head_sha" == "$commit_sha" ]] || {
    release_contract_error "release candidate run $run_id SHA '$head_sha' does not match '$commit_sha'"
    return 1
  }
  [[ "$display_title" == "$expected_title" ]] || {
    release_contract_error "release candidate run $run_id title does not match '$expected_title'"
    return 1
  }
  [[ "$event" == "workflow_dispatch" && "$workflow_name" == "Release Candidate" ]] || {
    release_contract_error "run $run_id is not a Release Candidate workflow_dispatch run"
    return 1
  }

  artifact_rows=$(gh api "repos/$repo/actions/runs/$run_id/artifacts" \
    --jq ".artifacts[] | select(.name == \"$expected_artifact\") | \"\(.id)\\t\(.expired)\"") || return 1
  [[ $(printf '%s\n' "$artifact_rows" | sed '/^$/d' | wc -l | tr -d ' ') == 1 ]] || {
    release_contract_error "release candidate run $run_id does not have exactly one '$expected_artifact' artifact"
    return 1
  }
  IFS=$'\t' read -r artifact_id artifact_expired <<< "$artifact_rows"
  [[ -n "$artifact_id" && "$artifact_expired" == "false" ]] || {
    release_contract_error "release candidate artifact '$expected_artifact' is missing or expired"
    return 1
  }
)

require_release_candidate_tag_annotation() {
  local annotation_file="${1:-}"
  local version="${2:-}"
  local public_sha="${3:-}"
  local public_count run_count annotation_sha run_id

  [[ -f "$annotation_file" ]] ||
    release_contract_error "release tag annotation does not exist: $annotation_file" || return 1
  require_release_version "$version" || return 1
  require_full_git_sha "$public_sha" || return 1
  [[ "$(head -n 1 "$annotation_file")" == "Release $version" ]] || {
    release_contract_error "release tag annotation must start with 'Release $version'"
    return 1
  }

  public_count=$(grep -c '^Public-mirror:' "$annotation_file" || true)
  run_count=$(grep -c '^Release-Candidate-Run:' "$annotation_file" || true)
  [[ "$public_count" == 1 && "$run_count" == 1 ]] || {
    release_contract_error "release tag annotation requires exactly one public SHA and candidate run binding"
    return 1
  }
  annotation_sha=$(sed -n 's/^Public-mirror: //p' "$annotation_file")
  run_id=$(sed -n 's/^Release-Candidate-Run: //p' "$annotation_file")
  [[ "$annotation_sha" == "$public_sha" ]] || {
    release_contract_error "release tag public SHA '$annotation_sha' does not match '$public_sha'"
    return 1
  }
  [[ "$run_id" =~ ^[0-9]+$ ]] || {
    release_contract_error "release tag candidate run ID must be numeric"
    return 1
  }
  echo "$run_id"
}

# Wait for the exact filtered GitHub master commit to pass the same workflow
# that a release tag will use. This must run before either canonical or public
# release tags are created; a tag is immutable release history, not a CI probe.
wait_for_github_master_gate() {
  local repo="$1"
  local commit_sha="$2"
  local timeout_seconds="${3:-900}"
  local workflow="${4:-release.yml}"
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local run_json run_id status conclusion

  command -v gh >/dev/null 2>&1 ||
    release_contract_error "gh CLI is required to verify the GitHub master gate"
  gh auth status >/dev/null 2>&1 ||
    release_contract_error "GitHub CLI authentication is required to verify the GitHub master gate"

  while (( $(date +%s) < deadline )); do
    run_json=$(gh run list \
      --repo "$repo" \
      --workflow "$workflow" \
      --branch master \
      --commit "$commit_sha" \
      --limit 1 \
      --json databaseId,status,conclusion \
      --jq 'if length == 0 then "" else "\(.[0].databaseId)\t\(.[0].status)\t\(.[0].conclusion // "")" end') ||
      return 1

    if [[ -n "$run_json" ]]; then
      IFS=$'\t' read -r run_id status conclusion <<< "$run_json"
      if [[ "$status" != "completed" ]]; then
        echo "Waiting for GitHub master gate run $run_id for $commit_sha..." >&2
        gh run watch "$run_id" --repo "$repo" --exit-status || return 1
        conclusion=$(gh run view "$run_id" --repo "$repo" --json conclusion --jq '.conclusion') || return 1
      fi
      require_workflow_success "$conclusion" || return 1
      echo "$run_id"
      return 0
    fi

    echo "Waiting for GitHub to register master gate for $commit_sha..." >&2
    sleep 5
  done

  release_contract_error "timed out waiting ${timeout_seconds}s for GitHub master gate on $commit_sha"
}

# Dispatch a new release-candidate run for one exact public master commit and
# wait for that newly created run. Pre-existing successful runs are excluded so
# each release attempt has an auditable, fresh acceptance result.
wait_for_github_release_candidate() (
  local repo="$1"
  local commit_sha="$2"
  local version="$3"
  local timeout_seconds="${4:-1800}"
  local workflow="${5:-release-candidate.yml}"
  local expected_title="Release candidate $version @ $commit_sha"
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local existing_runs run_rows run_id status conclusion display_title head_sha

  require_full_git_sha "$commit_sha" || return 1
  require_release_version "$version" || return 1
  [[ -n "$repo" ]] || { release_contract_error "GitHub repository is required for the release candidate gate"; return 1; }
  command -v gh >/dev/null 2>&1 || {
    release_contract_error "gh CLI is required to run the GitHub release candidate gate"
    return 1
  }
  gh auth status >/dev/null 2>&1 || {
    release_contract_error "GitHub CLI authentication is required to run the release candidate gate"
    return 1
  }

  existing_runs=$(mktemp)
  trap 'rm -f "$existing_runs"' EXIT
  gh run list \
    --repo "$repo" \
    --workflow "$workflow" \
    --limit 100 \
    --json databaseId \
    --jq '.[].databaseId' > "$existing_runs" || return 1

  gh workflow run "$workflow" \
    --repo "$repo" \
    --ref master \
    -f "candidate_sha=$commit_sha" \
    -f "version=$version" || return 1

  while (( $(date +%s) < deadline )); do
    run_rows=$(gh run list \
      --repo "$repo" \
      --workflow "$workflow" \
      --branch master \
      --commit "$commit_sha" \
      --event workflow_dispatch \
      --limit 20 \
      --json databaseId,status,conclusion,displayTitle,headSha \
      --jq ".[] | select(.displayTitle == \"$expected_title\" and .headSha == \"$commit_sha\") | \"\(.databaseId)\\t\(.status)\\t\(.conclusion // \"\")\\t\(.displayTitle)\\t\(.headSha)\"") || return 1

    run_id=""
    while IFS=$'\t' read -r candidate_id candidate_status candidate_conclusion candidate_title candidate_head_sha; do
      [[ -n "$candidate_id" ]] || continue
      if ! grep -Fxq "$candidate_id" "$existing_runs"; then
        run_id="$candidate_id"
        status="$candidate_status"
        conclusion="$candidate_conclusion"
        display_title="$candidate_title"
        head_sha="$candidate_head_sha"
        break
      fi
    done <<< "$run_rows"

    if [[ -n "$run_id" ]]; then
      [[ "$display_title" == "$expected_title" && "$head_sha" == "$commit_sha" ]] || {
        release_contract_error "release candidate run identity does not match $version at $commit_sha"
        return 1
      }
      if [[ "$status" != "completed" ]]; then
        echo "Waiting for GitHub release candidate run $run_id for $version at $commit_sha..." >&2
        gh run watch "$run_id" --repo "$repo" --exit-status || return 1
        conclusion=$(gh run view "$run_id" --repo "$repo" --json conclusion --jq '.conclusion') || return 1
      fi
      require_workflow_success "$conclusion" || return 1
      require_github_release_candidate_run "$repo" "$run_id" "$commit_sha" "$version" || return 1

      echo "$run_id"
      return 0
    fi

    echo "Waiting for GitHub to register a new release candidate for $version at $commit_sha..." >&2
    sleep 5
  done

  release_contract_error "timed out waiting ${timeout_seconds}s for release candidate $version at $commit_sha"
)

wait_for_github_tag_promotion() {
  local repo="$1"
  local version="$2"
  local commit_sha="$3"
  local timeout_seconds="${4:-900}"
  local workflow="${5:-release-promote.yml}"
  local deadline=$(( $(date +%s) + timeout_seconds ))
  local run_row run_id status conclusion head_sha

  [[ -n "$repo" ]] || release_contract_error "GitHub repository is required for release promotion" || return 1
  require_release_version "$version" || return 1
  require_full_git_sha "$commit_sha" || return 1
  command -v gh >/dev/null 2>&1 ||
    release_contract_error "gh CLI is required to verify GitHub release promotion" || return 1
  gh auth status >/dev/null 2>&1 ||
    release_contract_error "GitHub CLI authentication is required to verify GitHub release promotion" || return 1

  while (( $(date +%s) < deadline )); do
    run_row=$(gh run list \
      --repo "$repo" \
      --workflow "$workflow" \
      --branch "$version" \
      --commit "$commit_sha" \
      --event push \
      --limit 1 \
      --json databaseId,status,conclusion,headSha \
      --jq 'if length == 0 then "" else "\(.[0].databaseId)\t\(.[0].status)\t\(.[0].conclusion // "")\t\(.[0].headSha)" end') || return 1

    if [[ -n "$run_row" ]]; then
      IFS=$'\t' read -r run_id status conclusion head_sha <<< "$run_row"
      [[ "$head_sha" == "$commit_sha" ]] || {
        release_contract_error "release promotion run $run_id SHA '$head_sha' does not match '$commit_sha'"
        return 1
      }
      if [[ "$status" != "completed" ]]; then
        echo "Waiting for GitHub release promotion run $run_id for $version at $commit_sha..." >&2
        gh run watch "$run_id" --repo "$repo" --exit-status || return 1
        conclusion=$(gh run view "$run_id" --repo "$repo" --json conclusion --jq '.conclusion') || return 1
      fi
      require_workflow_success "$conclusion" || return 1
      echo "$run_id"
      return 0
    fi

    echo "Waiting for GitHub to register release promotion for $version at $commit_sha..." >&2
    sleep 5
  done

  release_contract_error "timed out waiting ${timeout_seconds}s for release promotion $version at $commit_sha"
}

require_release_assets() {
  local asset_list_file="$1"
  [[ -f "$asset_list_file" ]] ||
    release_contract_error "release asset list does not exist: $asset_list_file"

  local binaries=(
    pocketctl_darwin_arm64
    pocketctl_darwin_amd64
    pocketctl_linux_arm64
    pocketctl_linux_amd64
    pocketctl_windows_arm64.exe
    pocketctl_windows_amd64.exe
  )
  local binary
  for binary in "${binaries[@]}"; do
    grep -Fxq "$binary" "$asset_list_file" ||
      release_contract_error "release asset missing: $binary" || return 1
    grep -Fxq "${binary}.sha256" "$asset_list_file" ||
      release_contract_error "release checksum missing: ${binary}.sha256" || return 1
  done
}

require_promoted_release_assets() {
  local asset_list_file="$1"
  local total_count unique_count

  require_release_assets "$asset_list_file" || return 1
  grep -Fxq release-candidate-manifest.json "$asset_list_file" ||
    release_contract_error "release manifest missing: release-candidate-manifest.json" || return 1

  total_count=$(awk 'NF { count++ } END { print count + 0 }' "$asset_list_file")
  unique_count=$(awk 'NF' "$asset_list_file" | sort -u | wc -l | tr -d '[:space:]')
  [[ "$total_count" == 13 && "$unique_count" == 13 ]] || {
    release_contract_error "promoted release must contain exactly 13 unique assets (found $total_count entries, $unique_count unique)"
    return 1
  }
}
