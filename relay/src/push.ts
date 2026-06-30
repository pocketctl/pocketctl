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

// APNs configuration from environment
const APNS_KEY_PATH = process.env.APNS_KEY_PATH || '';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.pocketctl.app';
const APNS_ENVIRONMENT = process.env.APNS_ENVIRONMENT || 'development';

const APNS_HOST = APNS_ENVIRONMENT === 'production'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

// Cached JWT token for APNs auth
let cachedToken = '';
let tokenExpiresAt = 0;

/**
 * Generate APNs JWT token using .p8 key.
 * Token is valid for 1 hour; cached and regenerated as needed.
 */
function generateAPNsToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiresAt - 60) {
    return cachedToken;
  }

  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) {
    throw new Error('APNs not configured: missing APNS_KEY_PATH, APNS_KEY_ID, or APNS_TEAM_ID');
  }

  const privateKey = fs.readFileSync(APNS_KEY_PATH, 'utf8');
  const header = { alg: 'ES256', kid: APNS_KEY_ID };
  const payload = { iss: APNS_TEAM_ID, iat: now };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signInput = `${headerB64}.${payloadB64}`;

  const signature = crypto
    .createSign('SHA256')
    .update(signInput)
    .sign(privateKey, 'base64url');

  cachedToken = `${signInput}.${signature}`;
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
      'apns-topic': APNS_BUNDLE_ID,
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
  if (!APNS_KEY_PATH) {
    // Development mode: log only
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
