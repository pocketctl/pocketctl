ARG WORKER_BASE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-qwenpaw-worker@sha256:d76d91853a270dc4906273cda9fcf4ed32f610340a6833756633e610488e5eef
FROM ${WORKER_BASE}
COPY install.py pocketctl_filesync.py /opt/pocketctl-agentteams-compat/
RUN python3 /opt/pocketctl-agentteams-compat/install.py
LABEL pocketctl.agentteams.compat="v1.2.5-identical-file-v1"
