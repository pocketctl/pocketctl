export const REVIEW_ASSIST_MIGRATION={version:61,statements:[`ALTER TABLE memory_review_decisions ADD COLUMN review_duration_ms INTEGER CHECK(review_duration_ms BETWEEN 0 AND 86400000)`]}
