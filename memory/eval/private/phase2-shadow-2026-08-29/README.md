# Phase 2 Shadow human-label package

Private local dataset. Do not commit, upload, or send outside the authorized environment.

## Files

- `manifest.json`: aggregate coverage and exact candidate SHA.
- `cases.jsonl`: versioned private evaluation cases.
- `labels-template.json`: empty human-label contract.
- `labeling.html`: standalone offline labeling UI using browser localStorage.
- `validate-labels.mjs`: validates a UI export and computes roadmap metrics.

## Workflow

1. Open `labeling.html` locally.
2. Enter the human reviewer identity.
3. Review the fixed 100-Turn Gate sample and label every item as useful, irrelevant, duplicate, incorrect, or harmful. The two bulk buttons fill only unlabeled items in the current Turn and preserve existing labels.
4. Export `human-labels.json` into this directory.
5. Run: `node validate-labels.mjs human-labels.json`.

The query is reconstructed from the nearest authorized user_text event because compile query bodies are intentionally not persisted. Reviewers must mark uncertain or mismatched reconstructions in notes; do not invent a positive label. The package contains no prefilled model labels.

The Gate sample is deterministic: it first includes repository and adapter coverage, then at least 20 distinct sessions, and finally fills to the roadmap minimum of 100 eligible turns. Browser progress continues to use `pocketctl:phase2-shadow-2026-08-29`, so reopening the updated page preserves prior work.
