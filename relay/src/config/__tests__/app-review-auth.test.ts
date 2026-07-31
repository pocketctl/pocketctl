import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAppReviewEnabled, isAppReviewEmail, verifyAppReviewCode } from '../app-review-auth.js';

describe('App Review email authentication', () => {
  beforeEach(() => { process.env.APP_REVIEW_ENABLED = 'true'; });
  afterEach(() => { delete process.env.APP_REVIEW_ENABLED; });

  it('is disabled by default and enabled only by an explicit true value', () => {
    delete process.env.APP_REVIEW_ENABLED;
    expect(isAppReviewEnabled()).toBe(false);
    process.env.APP_REVIEW_ENABLED = 'false';
    expect(isAppReviewEnabled()).toBe(false);
    process.env.APP_REVIEW_ENABLED = 'true';
    expect(isAppReviewEnabled()).toBe(true);
  });

  it('recognizes only the normalized review email', () => {
    expect(isAppReviewEmail(' appreview@pocketctl.me ')).toBe(true);
    expect(isAppReviewEmail('APPREVIEW@POCKETCTL.ME')).toBe(true);
    expect(isAppReviewEmail('reviewer@pocketctl.me')).toBe(false);
  });

  it('accepts the fixed code only for the review email', () => {
    expect(verifyAppReviewCode('appreview@pocketctl.me', '123456')).toBe(true);
    expect(verifyAppReviewCode('appreview@pocketctl.me', '654321')).toBe(false);
    expect(verifyAppReviewCode('user@example.com', '123456')).toBe(false);
  });

  it('rejects the review email and fixed code when disabled', () => {
    process.env.APP_REVIEW_ENABLED = 'false';
    expect(isAppReviewEmail('appreview@pocketctl.me')).toBe(false);
    expect(verifyAppReviewCode('appreview@pocketctl.me', '123456')).toBe(false);
  });
});
