/**
 * Push notification service.
 * Development mode: logs to console.
 * Production: integrates with APNs (iOS) via HTTP/2.
 */

import type pg from 'pg';
import { getDevicesByUser } from './db.js';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send a push notification to a single device token.
 * Currently logs to console; replace with APNs HTTP/2 in production.
 */
export async function sendPushNotification(
  deviceToken: string,
  platform: string,
  payload: PushPayload,
): Promise<void> {
  // Development mode: log instead of sending
  console.log(`[push] ${platform} → ${deviceToken.slice(0, 16)}... | ${payload.title}: ${payload.body}`);
  if (payload.data) {
    console.log(`[push] data:`, JSON.stringify(payload.data));
  }

  // TODO: Production APNs integration
  // if (platform === 'ios') {
  //   await sendAPNs(deviceToken, payload);
  // }
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
      sendPushNotification(device.device_token, device.platform, payload).catch((err) =>
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
