# Phase 2 Shadow lifecycle-v3 human-label package

Private local dataset. Do not commit, upload, or send outside the authorized environment.

This package fixes the product Gate denominator to exactly 100 unique Memory Packs across 20 sessions, 3 repositories, and 2 adapters. It requires **100 Pack judgments**, not 300 item labels. Each page shows all three Context Pack items; choose the worst applicable Pack label using: harmful > incorrect > duplicate > irrelevant > useful. This conservative rule ensures a mixed Pack is not counted as useful when any displayed item is bad.

## Workflow

1. Open `labeling.html` locally.
2. Enter reviewer identity.
3. Review all displayed items and click one Pack verdict; the UI advances automatically.
4. Export `human-labels.json` into this directory.
5. Run `node validate-labels.mjs human-labels.json`.

No model labels are prefilled. The fixed sample is not recomputed by the validator.
