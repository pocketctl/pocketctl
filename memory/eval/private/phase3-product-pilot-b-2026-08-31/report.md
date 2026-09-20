# Phase 3 Product Pilot B — strict verdict

## Verdict

`PARTIAL / DEFERRED / NO-GO`.

Four ordinary read-only PocketCtl tasks were created after the frozen cutoff and
all four completed a durable Relay turn. Memory produced four ready/completed
episodes. Three sessions completed extraction and produced 27 validated
candidates; the fourth extraction was interrupted by the mandatory Provider
budget safety stop.

This does not satisfy the Phase 3 Product Effect Gate. Participant plan B has no
independent reviewer, no candidate was reviewed or promoted, and Team Recall,
revocation latency, repeated-investigation reduction, and the six required real
governance lifecycle examples all retain zero denominators.

## Safety counts

- Personal-to-shared leaks: 0.
- Unauthorized publications: 0.
- Shared Context injections: 0.
- Shared claims created during the Pilot: 0.

These are safety observations only. They do not establish shared-knowledge
product quality because no shared publication or Recall case occurred.

## Provider budget stop

Plan A allowed 50 text requests, 200,000 input tokens, and 50,000 output tokens.
Known final usage is 26 issued requests (25 with recorded usage), 72,069 input
tokens, and 148,839 output tokens. One interrupted request has unknown final
Provider-side usage. The known output overage is 98,839 tokens, or 297.678% of
the cap.

The overage consists of 46,663 output tokens from successful extraction runs
attached to the eligible new tasks and 90,894 output tokens from post-cutoff
background backlog extraction, plus the 11,282-token activation baseline. The
runtime records usage after Provider completion but has no Pilot pre-request
reservation/hard-cap enforcement. Memory worker was stopped at
2026-08-31T00:57:54Z and Memory API at 2026-08-31T00:58:49Z.

## Roadmap metrics

| Metric | Actual | Verdict |
|---|---:|---|
| Eligible new PocketCtl tasks | 4 | Sample collection complete |
| Durable completed turns | 4/4 | PASS |
| Ready/completed work episodes | 4/4 | PASS, one partially ingested at stop |
| Team Recall Top-5 | 0 cases | DEFERRED |
| Shared result Evidence/provenance | 0 shared results | DEFERRED |
| accepted/light-edit/rejected | 0 reviewed candidates | DEFERRED |
| revoke p95/max | 0 observations | DEFERRED |
| repeated-investigation reduction | 0 baseline/follow-up pairs | DEFERRED |
| required real lifecycle examples | 0/6 classes | DEFERRED |
| safety zero-counts | 0 / 0 / 0 | Observed PASS, no shared denominator |
| Provider budget | output 148,839 / 50,000 | FAIL / safety stop |

The Pilot must not be resumed with external Providers until pre-request budget
enforcement exists or the user explicitly authorizes a new budget and backlog
handling policy. Even after that fix, a second independent participant is still
required for a strict Product Effect Gate PASS.
