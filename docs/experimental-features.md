# Experimental features: Memory and Teams

[Back to README](../README.md)

These features require the corresponding service configuration and account access. They are not prerequisites for getting started.

## Memory (experimental)

Memory turns what agents learn about a repository into durable, reviewed
knowledge instead of context that vanishes with the session. It is optional
and managed from the Memory workbench in the Web app.

- **Knowledge ledger** — candidate knowledge extracted from repository sources
  enters an immutable, versioned ledger with evidence and confidence. Nothing
  is accepted until you review it; corrections create new versions instead of
  overwriting history.
- **Dependency code graph** — see how components depend on each other and run
  impact analysis before changing one.
- **Skill document governance** — operational skill documents (trigger,
  preconditions, steps, validation, rollback) follow an explicit candidate →
  review → approve/publish workflow instead of silent edits.
- **Pre-turn context injection** — on each new turn the daemon compiles the
  relevant knowledge into a hidden context pack and delivers it through the
  agent's native channel within a hard 750ms budget. Delivery is fail-open: on failure or budget
  expiry, the turn continues without requiring Memory to be available. The
  daemon never persists or logs pack contents.
- **MCP access** — hosting agents can query the same knowledge through an MCP
  bridge, so tools and the workbench share one source of truth.
- **Operational status** — the workbench reports stalled synchronization,
  budget waits, extraction stalls, and missing evidence. Oversized ordinary
  Feed content is quarantined so later events can continue; affected evidence
  cannot be used to extract or approve new knowledge.

Model-assisted extraction runs on the server and requires a configured
provider; without one the workbench stays unavailable instead of running
degraded. See [Security and data boundary](security-and-data.md) for
what leaves the development host.

## Team collaboration (experimental)

Team collaboration turns PocketCtl from a personal cross-device cockpit into a
small human-and-Agent workspace. In the Web and iOS clients you can:

- **Create Teams and manage membership** — invite members by email as admins,
  members, or read-only viewers; gate joining per account, change and audit
  roles with revision checks, and remove members. Removal revokes future reads
  and execution, and retained history never transfers native-session
  ownership.
- **Maintain lightweight tasks** — assign holders and track progress, separate
  from shared sessions and automatic runs.
- **Share sessions with frozen Context** — explicit collaboration events and
  versioned Context snapshots (goals, consensus, open questions, references)
  are shared with authenticated receipts; native private session logs are
  never shared automatically.
- **Call member-contributed Agents** — Codex, Claude Code, and DeepSeek
  Harness agents can join a Team as explicitly contributed, callable
  receivers with live
  presence and occupancy; narrow owner/daemon/offer/binding authorization and
  the existing quota and approval rules still apply.
- **Run bounded multi-Agent coordination (optional)** — frozen call,
  concurrency, and wall-time budgets with recovery for uncertain outcomes;
  uncertain work is never blindly retried.
- **Configure agents per session and route tasks** — each Team session picks
  its own callable agents with per-agent settings, and tasks can be assigned
  to a specific holder.
- **Keep private side-channels** — members can send interactions visible only
  to chosen receivers, and approvals travel an owner-only private channel.
- **Stay in sync across devices** — quoted replies and read states follow you
  between Web and iOS, and unsent messages survive reloads or offline periods
  in a per-device outbox.

Shared Memory is a separate opt-in bridge to an existing governed installation;
Team membership never grants knowledge access by itself — every participant and
receiver is revalidated, and only exact published Memory references are used.

Self-hosted operators must enable each phase independently with
`TEAM_COLLABORATION`, `TEAM_AUTORUN`, and `TEAM_MEMORY_BRIDGE`. All default to
`off`. See the
[feature matrix](team-collaboration-feature-matrix.md) and
[rollout runbook](operations/team-collaboration-rollout.md).
