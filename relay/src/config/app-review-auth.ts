const DEFAULT_APP_REVIEW_EMAIL = 'appreview@pocketctl.me';

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

/**
 * The reviewer's code must always be provisioned explicitly via
 * APP_REVIEW_CODE. There is no source-code default: a production relay
 * without an explicit code simply has no App Review bypass.
 */
export function explicitAppReviewCode(): string | null {
  const code = process.env.APP_REVIEW_CODE?.trim() ?? '';
  return /^\d{6}$/.test(code) ? code : null;
}
