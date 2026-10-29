"""Pinned TeamHarness subprocess. No autonomous leader loop or task credentials."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time
import base64
import hashlib
import subprocess

try:
    config_path = Path(sys.argv[1])
    info = config_path.lstat()
    assert stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_size <= 32768
    config = json.loads(config_path.read_text())
    raw = sys.stdin.buffer.read(96 * 1024 * 1024 + 1)
    assert len(raw) <= 96 * 1024 * 1024
    request = json.loads(raw)
    tool, args = request["tool"], request["arguments"]
    allowed = {"projectflow": {"create_project", "plan_dag"},
               "roomflow": {"create_task_room"}, "taskflow": {"delegate_task"},
               "pocketctl_inputs": {"upload_inputs"}}
    assert tool in allowed and args.get("action") in allowed[tool]
    assert tool == "pocketctl_inputs" or len(raw) <= 1024 * 1024
    project = args["projectId"]
    assert project.startswith("pctl-") and len(project) == 37 and all(c in "0123456789abcdef" for c in project[5:])
    if tool == "projectflow" and args["action"] == "create_project":
        assert args["teamId"] == config["teamId"] and args["sourceRoomId"] == config["teamRoomId"]
    if tool == "projectflow" and args["action"] == "plan_dag":
        assert len(args["tasks"]) == 1
        node = args["tasks"][0]
        assert node["taskId"] == project + "-01" and node["assignedTo"] == config["workerMatrixId"] and node["dependsOn"] == []
    if tool == "roomflow":
        assert args["invite"] == [config["workerMatrixId"]]
    if tool == "taskflow":
        assert args["taskId"] == project + "-01" and args["assignedTo"] == config["workerMatrixId"]
    if tool == "pocketctl_inputs":
        assert args["taskId"] == project + "-01"
    workspace = Path(config["workspace"])
    assert workspace.is_absolute()
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime = workspace / "pocketctl-runtime.json"
    # Installation-owned identity only. Model text cannot set a role or Team.
    expected_runtime = json.dumps({"member": {"role": "team_leader", "matrixUserId": config["leaderMatrixId"]},
                                  "team": {"name": config["teamId"], "teamRoomId": config["teamRoomId"],
                                           "admin": {"matrixUserId": config["adminMatrixId"]}}})
    if not runtime.exists():
        with runtime.open("x") as stream:
            os.chmod(runtime, 0o600)
            stream.write(expected_runtime)
    else:
        assert runtime.read_text() == expected_runtime
    os.environ.clear()
    os.environ.update({"PATH": "/usr/local/bin:/usr/bin:/bin", "TEAMHARNESS_RUNTIME_CONFIG": str(runtime),
                       "AGENTTEAMS_AGENT_ROLE": "leader", "AGENTTEAMS_WORKER_NAME": config["leaderName"],
                       "AGENTTEAMS_MATRIX_USER_ID": config["leaderMatrixId"],
                       "AGENTTEAMS_MATRIX_URL": config["matrixUrl"],
                       "AGENTTEAMS_WORKER_MATRIX_TOKEN": config["matrixToken"],
                       "AGENTTEAMS_STORAGE_PREFIX": "agentteams/agentteams-storage",
                       "AGENTTEAMS_SHARED_STORAGE_PREFIX": "teams/" + config["teamId"] + "/shared",
                       "AGENTTEAMS_FS_ENDPOINT": config["storageEndpoint"],
                       "AGENTTEAMS_FS_ACCESS_KEY": config["storageAccessKey"],
                       "AGENTTEAMS_FS_SECRET_KEY": config["storageSecretKey"]})
    source = Path("/opt/agentteams/plugins/teamharness/mcp/server.py")
    sys.path.insert(0, str(source.parent))
    spec = importlib.util.spec_from_file_location("pocketctl_upstream_teamharness", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    args["workspaceDir"] = str(workspace)
    if tool == "pocketctl_inputs":
        # PocketCtl-owned operation around pinned upstream filesync. Only this
        # deterministic task's frozen input directory is writable, never a
        # caller-supplied remote, storage prefix, tool name or workspace.
        files = args["files"]
        assert isinstance(files, list) and 1 <= len(files) <= 129
        seen, decoded, total = set(), [], 0
        for item in files:
            name = item["path"]
            assert name not in seen
            seen.add(name)
            is_index = name == "inputs.json"
            if not is_index:
                assert name.startswith("files/") and len(name) == 70 and all(c in "0123456789abcdef" for c in name[6:])
            blob = base64.b64decode(item["data"], validate=True)
            assert 0 < len(blob) <= (512 * 1024 if is_index else 2 * 1024 * 1024)
            assert hashlib.sha256(blob).hexdigest() == item["sha256"]
            if not is_index:
                total += len(blob)
            decoded.append((name, blob))
        assert "inputs.json" in seen and total <= 64 * 1024 * 1024
        directory = "shared/tasks/" + args["taskId"] + "/pocketctl-inputs"
        for name, blob in decoded:
            current = workspace
            for part in (directory + "/" + name).split("/")[:-1]:
                current = current / part
                current.mkdir(exist_ok=True, mode=0o700)
                assert stat.S_ISDIR(current.lstat().st_mode) and not current.is_symlink()
            target = workspace / directory / name
            if target.exists() or target.is_symlink():
                assert stat.S_ISREG(target.lstat().st_mode) and target.stat().st_size == len(blob)
                assert target.read_bytes() == blob
            else:
                with target.open("xb") as stream:
                    os.chmod(target, 0o400)
                    stream.write(blob)
                    stream.flush()
                    os.fsync(stream.fileno())
        pushed = module._filesync({"action": "push", "path": directory + "/", "workspaceDir": str(workspace)})
        assert pushed.get("ok")
        # Independently read back actual object bytes with bounded stdout.
        # A successful upload command alone is not transfer acceptance.
        for name, blob in decoded:
            _, _, _, remote, _ = module._resolve_filesync({"action": "stat", "path": directory + "/" + name, "workspaceDir": str(workspace)})
            environment, error = module._filesync_mc_env(remote)
            assert not error
            process = subprocess.Popen(["mc", "cat", remote], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)
            try:
                actual = process.stdout.read(len(blob) + 1)
                assert actual == blob
                assert process.wait(timeout=10) == 0
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()
        print(json.dumps({"ok": True, "files": len(files), "bytes": total, "readbackVerified": True}))
        raise SystemExit(0)
    if tool == "taskflow":
        # Waiting for an invited member to join is read-only; delegate once.
        deadline = time.monotonic() + 25
        while not module._validate_assignee_membership(args["roomId"], config["workerMatrixId"]).get("ok"):
            if time.monotonic() >= deadline:
                raise TimeoutError()
            time.sleep(0.25)
    result = module.call_tool(tool, args)
    assert len(result["content"]) == 1 and result["content"][0]["type"] == "text"
    payload = json.loads(result["content"][0]["text"])
    print(json.dumps(payload, ensure_ascii=False))
except Exception as error:
    # No remote message, stderr, model input or credential is an API error.
    print(json.dumps({"ok": False, "error_kind": type(error).__name__}))
    raise SystemExit(1)
