import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explicitAppReviewCode, isAppReviewEmail, isAppReviewEnabled } from '../app-review-auth.js';

describe('App Review email authentication', () => {
  beforeEach(() => { process.env.APP_REVIEW_ENABLED = 'true'; });
  afterEach(() => {
    delete process.env.APP_REVIEW_ENABLED;
    delete process.env.APP_REVIEW_CODE;
  });

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

  it('has no source-code default code: unset or malformed APP_REVIEW_CODE yields null', () => {
    delete process.env.APP_REVIEW_CODE;
    expect(explicitAppReviewCode()).toBeNull();
    process.env.APP_REVIEW_CODE = '12345';
    expect(explicitAppReviewCode()).toBeNull();
    process.env.APP_REVIEW_CODE = 'not-a-code';
    expect(explicitAppReviewCode()).toBeNull();
    process.env.APP_REVIEW_CODE = '654321';
    expect(explicitAppReviewCode()).toBe('654321');
  });
});
