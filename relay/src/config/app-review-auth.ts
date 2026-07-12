const DEFAULT_APP_REVIEW_EMAIL = 'appreview@pocketctl.me';
const DEFAULT_APP_REVIEW_CODE = '123456';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAppReviewEnabled(): boolean {
  return process.env.APP_REVIEW_ENABLED?.trim().toLowerCase() === 'true';
}

export function isConfiguredAppReviewEmail(email: string): boolean {
  const configuredEmail = process.env.APP_REVIEW_EMAIL || DEFAULT_APP_REVIEW_EMAIL;
  return normalizeEmail(email) === normalizeEmail(configuredEmail);
}

export function isAppReviewEmail(email: string): boolean {
  return isAppReviewEnabled() && isConfiguredAppReviewEmail(email);
}

export function verifyAppReviewCode(email: string, code: string): boolean {
  const configuredCode = process.env.APP_REVIEW_CODE || DEFAULT_APP_REVIEW_CODE;
  return isAppReviewEmail(email) && code === configuredCode;
}
