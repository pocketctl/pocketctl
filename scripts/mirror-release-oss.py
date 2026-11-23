"""Mirror a verified release bundle to Beijing OSS, preserving existing objects."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

import oss2


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


def mirror(bucket, version, bundle):
    manifest = bundle / "release-candidate-manifest.json"
    files = []
    for asset in json.loads(manifest.read_text())["assets"]:
        files.extend([asset["name"], asset["name"] + ".sha256"])
    with tempfile.TemporaryDirectory() as directory:
        scratch = Path(directory) / "readback"
        for name in [*files, manifest.name]:
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
    auth = oss2.StsAuth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"],
                        os.environ["OSS_SESSION_TOKEN"], auth_version=oss2.AUTH_VERSION_4)
    bucket = oss2.Bucket(auth, "https://oss-cn-beijing.aliyuncs.com", "pocketctl-daemon",
                         region="cn-beijing")
    mirror(bucket, sys.argv[1], Path(sys.argv[2]))
