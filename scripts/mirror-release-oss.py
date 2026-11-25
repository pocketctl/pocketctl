"""Mirror a verified release bundle to Beijing OSS or prune its historical release objects."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

import oss2


RETAIN_RELEASES = 20
RELEASE_TAG = re.compile(r"v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-rc([0-9]+))?")


def readback_matches(bucket, key, source, scratch):
    try:
        bucket.get_object_to_file(key, str(scratch))
    except oss2.exceptions.NoSuchKey:
        return False
    if scratch.stat().st_size != source.stat().st_size or digest(scratch) != digest(source):
        raise ValueError(f"Published object differs from the verified release: {key}")
    return True


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.digest()


def version_order(tag):
    major, minor, patch, rc = RELEASE_TAG.fullmatch(tag).groups()
    return int(major), int(minor), int(patch), rc is None, int(rc or 0)


def release_files(bundle):
    manifest = bundle / "release-candidate-manifest.json"
    files = []
    for asset in json.loads(manifest.read_text())["assets"]:
        files.extend([asset["name"], asset["name"] + ".sha256"])
    return [*files, manifest.name]


def release_inventory(bucket):
    inventory = {}
    for obj in oss2.ObjectIterator(bucket, prefix="releases/"):
        tag, _, name = obj.key[len("releases/"):].partition("/")
        if RELEASE_TAG.fullmatch(tag) and name:
            inventory.setdefault(tag, set()).add(name)
    return inventory


def prune_history(bucket, current, files):
    inventory = release_inventory(bucket)
    assets = set(files)
    complete = sorted((tag for tag, names in inventory.items() if assets <= names),
                      key=version_order, reverse=True)
    if current not in complete:
        raise ValueError(f"Verified release missing from OSS inventory: {current}")
    if len(complete) < RETAIN_RELEASES:
        print(f"Only {len(complete)} complete releases; deleted 0 objects")
        return

    cutoff = min(version_order(complete[RETAIN_RELEASES - 1]), version_order(current))
    latest_stable = next((tag for tag in complete if "-rc" not in tag), None)
    candidates = {}
    for tag, names in inventory.items():
        if version_order(tag) < cutoff and tag != latest_stable:
            keys = sorted(f"releases/{tag}/{name}" for name in names & assets)
            if keys:
                candidates[tag] = keys

    count = sum(map(len, candidates.values()))
    print(f"Retention cutoff {complete[RETAIN_RELEASES - 1]}, current {current}, "
          f"latest complete stable {latest_stable}; planned deletions: {count}", flush=True)
    for tag in sorted(candidates, key=version_order):
        keys = candidates[tag]
        print(f"Deleting {keys}", flush=True)
        result = bucket.batch_delete_objects(keys)
        if set(result.deleted_keys) != set(keys):
            raise RuntimeError(f"Incomplete OSS deletion response for {tag}")

    if candidates:
        remaining = release_inventory(bucket)
        for tag in candidates:
            if remaining.get(tag, set()) & assets:
                raise RuntimeError(f"Release objects still visible after deletion: {tag}")
    print(f"Verified deletion of {count} objects across {len(candidates)} historical releases")


def mirror(bucket, version, bundle):
    with tempfile.TemporaryDirectory() as directory:
        scratch = Path(directory) / "readback"
        for name in release_files(bundle):
            source = bundle / name
            key = f"releases/{version}/{name}"
            if not readback_matches(bucket, key, source, scratch):
                try:
                    bucket.put_object_from_file(key, str(source), headers={
                        "x-oss-forbid-overwrite": "true",
                        "Cache-Control": "public, max-age=31536000, immutable",
                    })
                except oss2.exceptions.ServerError as exc:
                    if exc.code != "FileAlreadyExists":
                        raise
                if not readback_matches(bucket, key, source, scratch):
                    raise ValueError(f"Missing after upload: {key}")
            print(f"Verified {key} ({source.stat().st_size} bytes)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--prune-history", action="store_true")
    args = parser.parse_args()
    auth = oss2.StsAuth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"],
                        os.environ["OSS_SESSION_TOKEN"], auth_version=oss2.AUTH_VERSION_4)
    bucket = oss2.Bucket(auth, "https://oss-cn-beijing.aliyuncs.com", "pocketctl-daemon",
                         region="cn-beijing")
    if args.prune_history:
        prune_history(bucket, args.version, release_files(args.bundle))
    else:
        mirror(bucket, args.version, args.bundle)
