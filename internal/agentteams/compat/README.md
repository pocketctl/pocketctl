# Pinned AgentTeams Worker compatibility

This image extends AgentTeams v1.2.5 at the digest in `Dockerfile`. The build
checks the exact builtin TeamHarness source SHA before modifying it and updates
the upstream builtin-plugin digest, so the actual Worker installs the same code.
It does not change the Controller, scheduler, task identity, or model tool list.

The patch handles one upstream behavior: `_filesync(push)` rejects an unchanged
file when its remote modification time is newer. For PocketCtl-generated task
paths only, it reads at most the local length plus one byte (maximum 2 MiB) from
the original resolved remote object, with a 20-second timeout. Equal bytes plus
an unchanged local file return a verified reuse receipt without uploading.
Different bytes, symlinks, size overflow, failed authorization/read, or concurrent
local edits keep the original conflict. It never copies credentials into output.

```
python3 -m unittest discover -s internal/agentteams/compat -p 'test_*.py'
docker build -t pocketctl-agentteams-worker:t17-compat-20261028 internal/agentteams/compat
```

The isolated T17 deployment uses `deploy-agentteams-worker-compat-t17.mjs` after
all named Worker chats are verified idle. It preserves the pending source
submission before replacement. Upstream startup can overwrite unsynced local
metadata with an older remote copy; the script records the exact backup recovery.
This recovery is an operator-assisted acceptance action, not an automatic product
recovery feature. Do not reuse that fixed-task recovery script for other tasks.

Evidence: `docs/reports/team-delivery/p2/20261028-agentteams-t17/` contains the
compatibility deployment, actual no-write reuse, original-submission recovery,
real P1 chain, tool-read audit, and completed-call restart reports. In-flight
faults, current authorization revocation, active model stop, UI recovery and
product metering still require their own acceptance.
