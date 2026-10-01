# Team collaboration feature matrix

Team collaboration is experimental, server-gated and currently available in the Web client only. Discovery of an Agent does not make it callable: its daemon and runtime must advertise the Team v1 dispatch, Context and receipt capabilities.

| Capability | Web | iOS | Server gate | Boundary |
| --- | --- | --- | --- | --- |
| Team create/rename/dissolve | Experimental | Not available | `TEAM_COLLABORATION` | Creator manages lifecycle; retained history is not a native-session ownership transfer |
| Invitations and membership | Experimental | Not available | `TEAM_COLLABORATION` | Pending invite is not membership; removal revokes future reads/execution |
| Lightweight tasks and holders | Experimental | Not available | `TEAM_COLLABORATION` | Separate from shared sessions and automatic runs |
| Shared sessions/events | Experimental | Not available | `TEAM_COLLABORATION` | Only explicit collaboration events are shared; native private logs remain owner-scoped |
| Direct Agent calls | Experimental | Not available | `TEAM_COLLABORATION` + daemon capabilities | Narrow owner/daemon/offer/binding authorization; existing quota and approval rules apply |
| Frozen shared Context | Experimental | Not available | `TEAM_COLLABORATION` | Versioned snapshot, bounded payload and authenticated receipt |
| Bounded multi-Agent run | Experimental | Not available | `TEAM_AUTORUN` | Creator-controlled; frozen call/concurrency/time budgets; uncertain work is not retried |
| Shared Memory binding/search | Experimental | Not available | `TEAM_MEMORY_BRIDGE` + Extension v2 | Binds an existing installation and grants; never creates an organization implicitly |
| Exact published Memory references | Experimental | Not available | Same as above | Every participant and receiver is revalidated; separate pack/nonce/receipt per call |
| Personal sessions | Supported | Supported | Independent | Continue working when every Team flag is off |
| Personal Memory workbench | Supported | Not available | Independent | Continues working when Team Memory is off |

## Rollout status

- Code and automated regression can qualify phases B–D as release candidates.
- Production opening additionally requires the real browser, multi-user/multi-host Agent and, for phase D, two-receiver Memory evidence in `scripts/verification/team/scenarios.md`.
- Until those evidence records are attached to the candidate SHA, operators must keep `TEAM_COLLABORATION`, `TEAM_AUTORUN` and `TEAM_MEMORY_BRIDGE` off.

See `docs/contracts/team-collaboration-v1.md` for the authorization contract and `docs/operations/team-collaboration-rollout.md` for rollout and shutdown.
