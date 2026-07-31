import { describe, expect, test } from 'vitest';
import { sanitizeOpenCodeRuntimeTelemetry } from '../router.js';

describe('OpenCode rollout telemetry', () => {
  test('retains only fixed count categories and discards arbitrary content', () => {
    expect(sanitizeOpenCodeRuntimeTelemetry({
      fallback_reasons: {
        daemon_unavailable: 3,
        'prompt=/private/repo answer=yes': 99,
        session_busy: -2,
      },
      health_ok: 5,
      health_failed: 'private error text',
    })).toEqual({
      fallbackReasons: { daemon_unavailable: 3, session_busy: 0 },
      healthOK: 5,
      healthFailed: 0,
    });
  });
});
