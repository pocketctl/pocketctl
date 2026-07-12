/**
 * Push notification service.
 * Development mode: logs to console.
 * Production: sends via APNs HTTP/2 with .p8 token authentication.
 */

import type pg from 'pg';
import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { getDevicesByUser, removeInvalidDeviceToken } from './db.js';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface APNsConfig {
  enabled: boolean;
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: 'development' | 'production';
  error?: string;
}

/** Resolve APNs settings once at process start and expose actionable errors. */
export function resolveAPNsConfig(env: NodeJS.ProcessEnv): APNsConfig {
  const keyPath = env.APNS_KEY_PATH || '';
  const keyId = env.APNS_KEY_ID || '';
  const teamId = env.APNS_TEAM_ID || '';
  const bundleId = env.APNS_BUNDLE_ID || 'com.pocketctl.app';
  const environment = env.APNS_ENVIRONMENT === 'production'
    || (!env.APNS_ENVIRONMENT && env.NODE_ENV === 'production')
    ? 'production'
    : 'development';
  const missing = [
    ['APNS_KEY_PATH', keyPath],
    ['APNS_KEY_ID', keyId],
    ['APNS_TEAM_ID', teamId],
  ].filter(([, value]) => !value).map(([name]) => name);
  const production = env.NODE_ENV === 'production';

  return {
    enabled: missing.length === 0,
    keyPath,
    keyId,
    teamId,
    bundleId,
    environment,
    error: production && missing.length > 0
      ? `APNs not configured: missing ${missing.join(', ')}`
      : undefined,
  };
}

const APNS_CONFIG = resolveAPNsConfig(process.env);
if (APNS_CONFIG.error) {
  console.error(`[push] ${APNS_CONFIG.error}; remote notifications are disabled`);
} else if (APNS_CONFIG.enabled) {
  console.log(`[push] APNs enabled (${APNS_CONFIG.environment}, ${APNS_CONFIG.bundleId})`);
}

const APNS_HOST = APNS_CONFIG.environment === 'production'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

// Cached JWT token for APNs auth
let cachedToken = '';
let tokenExpiresAt = 0;

/** Create the ES256 provider JWT required by APNs. */
export function signAPNsJWT(
  privateKey: crypto.KeyObject,
  keyId: string,
  teamId: string,
  issuedAt: number,
): string {
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: issuedAt };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createSign('SHA256')
    .update(signInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  return `${signInput}.${signature}`;
}

/**
 * Generate APNs JWT token using .p8 key.
 * Token is valid for 1 hour; cached and regenerated as needed.
 */
function generateAPNsToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiresAt - 60) {
    return cachedToken;
  }

  if (!APNS_CONFIG.enabled) {
    throw new Error(APNS_CONFIG.error || 'APNs not configured');
  }

  const privateKey = crypto.createPrivateKey(fs.readFileSync(APNS_CONFIG.keyPath, 'utf8'));
  cachedToken = signAPNsJWT(privateKey, APNS_CONFIG.keyId, APNS_CONFIG.teamId, now);
  tokenExpiresAt = now + 3500; // ~1 hour
  return cachedToken;
}

/**
 * Send a push notification to a single device via APNs HTTP/2.
 * Returns true on success, false on failure.
 */
async function sendAPNs(deviceToken: string, payload: PushPayload): Promise<{ ok: boolean; statusCode?: number }> {
  const token = generateAPNsToken();
  const path = `/3/device/${deviceToken}`;

  const apnsPayload = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      badge: 1,
    },
    ...payload.data,
  });

  return new Promise((resolve) => {
    const session = http2.connect(APNS_HOST);
    const req = session.request({
      ':method': 'POST',
      ':path': path,
      'authorization': `bearer ${token}`,
      'apns-topic': APNS_CONFIG.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let responseBody = '';
    let statusCode = 0;

    req.on('response', (headers) => {
      statusCode = (headers[':status'] as number) || 0;
    });
    req.on('data', (chunk) => { responseBody += chunk; });
    req.on('end', () => {
      session.close();
      if (statusCode === 200) {
        resolve({ ok: true, statusCode });
      } else {
        console.error(`[push] APNs error ${statusCode}: ${responseBody}`);
        resolve({ ok: false, statusCode });
      }
    });
    req.on('error', (err) => {
      session.close();
      console.error(`[push] APNs connection error: ${err.message}`);
      resolve({ ok: false });
    });

    req.setEncoding('utf8');
    req.write(apnsPayload);
    req.end();
  });
}

/**
 * Send a push notification to a single device token.
 * Development mode: logs to console.
 * Production: sends via APNs HTTP/2.
 */
export async function sendPushNotification(
  pool: pg.Pool,
  deviceToken: string,
  platform: string,
  payload: PushPayload,
): Promise<void> {
  if (!APNS_CONFIG.enabled) {
    if (APNS_CONFIG.error) throw new Error(APNS_CONFIG.error);
    // Local development without credentials: log only.
    console.log(`[push] ${platform} → ${deviceToken.slice(0, 16)}... | ${payload.title}: ${payload.body}`);
    if (payload.data) console.log(`[push] data:`, JSON.stringify(payload.data));
    return;
  }

  if (platform === 'ios') {
    const result = await sendAPNs(deviceToken, payload);
    // APNs 410 = token no longer valid, 400 = bad request with bad token
    if (result.statusCode === 410 || result.statusCode === 400) {
      console.log(`[push] removing invalid device token: ${deviceToken.slice(0, 16)}...`);
      await removeInvalidDeviceToken(pool, deviceToken).catch(() => {});
    }
  }
}

/**
 * Send a push notification to all devices of a user.
 */
export async function notifyUser(
  pool: pg.Pool,
  userId: number,
  payload: PushPayload,
): Promise<void> {
  try {
    const devices = await getDevicesByUser(pool, userId);
    if (devices.length === 0) return;

    const promises = devices.map((device: any) =>
      sendPushNotification(pool, device.device_token, device.platform, payload).catch((err) =>
        console.error(`[push] failed for device ${device.id}:`, err.message)
      )
    );
    await Promise.allSettled(promises);
  } catch (err) {
    console.error('[push] notifyUser error:', (err as Error).message);
  }
}

/**
 * Build push payload for session status changes.
 */
export function sessionStatusPush(sessionTitle: string, status: string, sessionId: string): PushPayload {
  const statusText: Record<string, string> = {
    completed: '已完成',
    error: '出错了',
    killed: '已终止',
    exited: '已退出',
  };

  return {
    title: '会话状态更新',
    body: `${sessionTitle || sessionId.slice(0, 8)} ${statusText[status] || status}`,
    data: { type: 'session_status', session_id: sessionId, status },
  };
}

/**
 * Build push payload for daemon offline.
 */
export function daemonOfflinePush(hostname: string, daemonId: string): PushPayload {
  return {
    title: '主机离线',
    body: `${hostname} 已断开连接`,
    data: { type: 'daemon_offline', daemon_id: daemonId },
  };
}

/**
 * Build push payload for daemon online (reconnect after a genuine offline).
 * Symmetric to daemonOfflinePush. Pro-only (gated in router via maybePushToPro).
 */
export function daemonOnlinePush(hostname: string, daemonId: string): PushPayload {
  return {
    title: '主机上线',
    body: `${hostname} 已恢复连接`,
    data: { type: 'daemon_online', daemon_id: daemonId },
  };
}

/**
 * Build push payload for a tool-use approval request.
 * The agent is blocked waiting for a Yes/No; pushing to all of the owner's
 * devices so the agent doesn't stall while the app is backgrounded/killed.
 */
export function approvalPush(
  sessionTitle: string,
  toolName: string,
  summary: string,
  sessionId: string,
  requestId: string,
): PushPayload {
  const tool = toolName || '工具';
  const body = summary ? `${tool} 想执行 ${summary}` : `${tool} 请求你的授权`;
  return {
    title: '需要你的审批',
    body,
    data: { type: 'approval', session_id: sessionId, request_id: requestId },
  };
}

/**
 * Build push payload for an interactive prompt (agent needs text input / a
 * choice). Same attention-requiring class as approval.
 */
export function interactivePush(
  sessionTitle: string,
  prompt: string,
  sessionId: string,
  requestId: string,
): PushPayload {
  const body = truncate(prompt, 80) || '等待你的输入';
  return {
    title: 'Agent 需要你的输入',
    body,
    data: { type: 'interactive', session_id: sessionId, request_id: requestId },
  };
}

/**
 * Extract a human-readable summary from a tool's raw input payload.
 * - Bash: the `command` field
 * - Edit/Write/MultiEdit: the `file_path`
 * - Others: a trimmed JSON snippet
 * `input` may be an object, a JSON string, or undefined — parsed defensively.
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  let parsed: any = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return truncate(input, 80); }
  }
  if (!parsed || typeof parsed !== 'object') return '';

  const lower = tool.toLowerCase();
  if ((lower === 'bash' || lower === 'run') && typeof parsed.command === 'string') {
    return truncate(parsed.command, 80);
  }
  if (typeof parsed.file_path === 'string') {
    return truncate(parsed.file_path, 80);
  }
  if (typeof parsed.path === 'string') {
    return truncate(parsed.path, 80);
  }
  // Fallback: compact JSON snippet
  try { return truncate(JSON.stringify(parsed), 80); } catch { return ''; }
}

/** Truncate to `max` chars with an ellipsis, trimming whitespace. */
function truncate(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}

/**
 * Build push payload for a high-risk tool-use approval (Pro-only, sent in
 * addition to the regular approvalPush so Pro users get an extra warning).
 */
export function highRiskPush(
  sessionTitle: string,
  toolName: string,
  summary: string,
  sessionId: string,
  requestId: string,
): PushPayload {
  const tool = toolName || '工具';
  return {
    title: '⚠️ 高危操作待审批',
    body: `${tool}: ${truncate(summary, 60) || '检测到高危操作'}`,
    data: { type: 'high_risk', session_id: sessionId, request_id: requestId },
  };
}

/**
 * Format a token count compactly: 1234 → "1.2k", 1500000 → "1.5M".
 * Used in daily/weekly report push bodies.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/**
 * Build the daily token-usage report push (Pro-only). Fires once per UTC day,
 * covering the previous day's usage. `dateLabel` is a short label like "7月1日"
 * for the body; the caller computes it from the reporting day.
 */
export function dailyReportPush(dateLabel: string, totalTokens: number, requests: number): PushPayload {
  const tokens = formatTokens(totalTokens);
  return {
    title: '昨日 Token 用量',
    body: `${dateLabel}：${tokens} tokens · ${requests} 次请求`,
    data: { type: 'insights', subtype: 'daily_report' },
  };
}

/**
 * Build the weekly token-usage report push (Pro-only). Fires once per ISO week,
 * covering the 7 days ending Sunday. `weekLabel` is a short label like
 * "6/24–6/30" for the body.
 */
export function weeklyReportPush(weekLabel: string, totalTokens: number, requests: number): PushPayload {
  const tokens = formatTokens(totalTokens);
  return {
    title: '本周 Token 用量',
    body: `${weekLabel}：${tokens} tokens · ${requests} 次请求`,
    data: { type: 'insights', subtype: 'weekly_report' },
  };
}

/**
 * Detect high-risk commands / targets from a tool's human-readable summary
 * (the output of summarizeToolInput). Pure function, independently testable.
 *
 * Bash/Run: destructive shell patterns. Edit/Write: sensitive system paths.
 * Returns true when the operation is high-risk (Pro users get an extra push).
 */
export function isHighRiskCommand(tool: string, summary: string): boolean {
  const s = summary.toLowerCase();
  if (!s) return false;
  const lower = tool.toLowerCase();

  // Shell commands — match destructive patterns.
  if (lower === 'bash' || lower === 'run' || lower === 'sh') {
    const dangerous = [
      /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, // rm -rf / rm -fr
      /\bsudo\b/,
      /\bchmod\s+777\b/,
      /\bmkfs\b/,
      /\bdd\s+if=/,
      /\/dev\/sd[a-z]/,
      /\bgit\s+push\s+(-f|--force)\b/,
      /\bgit\s+push\s+.*--force/,
      /\bcurl\b.*\|\s*(sh|bash)\b/,
      /\bwget\b.*\|\s*(sh|bash)\b/,
      /\bdrop\s+(table|database)\b/i,
      /\btruncate\s+table\b/i,
      /\bkill\s+-9\b/,
      /\biptables\b/,
      /\b:\(\)\s*\{.*\};:/, // fork bomb
    ];
    return dangerous.some((re) => re.test(s));
  }

  // File edits/writes — sensitive system paths.
  if (typeof tool === 'string' && ['edit', 'write', 'multiedit', 'create'].includes(lower)) {
    const sensitivePaths = [
      '/etc/',
      '/usr/',
      '/system/',
      '/library/',
      '~/.ssh/',
      '.ssh/',
      '/etc/passwd',
      '/etc/sudoers',
      '~/.bashrc',
      '~/.zshrc',
      '~/.bash_profile',
      '/boot/',
    ];
    return sensitivePaths.some((p) => s.includes(p));
  }

  return false;
}
