#!/bin/bash
set -euo pipefail

# Export only committed files. Copying a directory from the working tree can
# expose ignored private evaluation data, local state, and untracked files.
[[ $# -eq 3 ]] || { echo 'usage: github-mirror-copy.sh SOURCE DEST ENTRY' >&2; exit 2; }
mirror_source=$1
mirror_destination=$2
mirror_entry=$3
[[ -d "$mirror_destination" ]] || { echo 'mirror destination missing' >&2; exit 2; }
git -C "$mirror_source" archive HEAD -- "$mirror_entry" | tar -x -C "$mirror_destination"
