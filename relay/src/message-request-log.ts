import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Never spread a command, response, Error, or socket into a log record.
// Correlation fields are bounded and restricted to identifier characters.
function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 160 && /^[\w.:-]+$/.test(value) ? value : null;
}

function emit(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ event: 'session_message_request', timestamp: new Date().toISOString(), ...fields }));
  } catch {
    // Observability must not change message admission or delivery behavior.
  }
}

interface Attempt {
  client: object;
  fields: Record<string, unknown>;
  started: number;
  active: boolean;
  outcome: string;
}

export class MessageRequestLog {
  private readonly attempts = new AsyncLocalStorage<Attempt>();
  private readonly connections = new WeakMap<object, string>();

  async run(client: object, userId: number | null, message: any, handler: () => Promise<void>): Promise<void> {
    let connectionId = this.connections.get(client);
    if (!connectionId) {
      connectionId = randomUUID();
      this.connections.set(client, connectionId);
    }
    const attempt: Attempt = {
      client, started: performance.now(), active: true, outcome: 'not_forwarded',
      fields: {
        attempt_id: randomUUID(), connection_id: connectionId, user_id: userId,
        session_id: identifier(message.session_id), msg_id: identifier(message.msg_id),
        request_id: identifier(message.request_id) ?? identifier(message.msg_id),
        content_bytes: typeof message.content === 'string' ? Buffer.byteLength(message.content, 'utf8') : 0,
      },
    };
    await this.attempts.run(attempt, async () => {
      this.record('received');
      try {
        await handler();
      } catch (error) {
        attempt.outcome = 'failed';
        this.record('failed', { reason: 'handler_exception' });
        throw error;
      } finally {
        this.record('finished', { outcome: attempt.outcome });
        attempt.active = false;
      }
    });
  }

  route(sessionId: unknown, daemonId?: unknown, requestId?: unknown): void {
    const attempt = this.attempts.getStore();
    if (!attempt?.active) return;
    attempt.fields.routed_session_id = identifier(sessionId);
    if (daemonId !== undefined) attempt.fields.daemon_id = identifier(daemonId);
    if (requestId !== undefined) attempt.fields.request_id = identifier(requestId);
  }

  record(stage: string, fields: Record<string, unknown> = {}): void {
    const attempt = this.attempts.getStore();
    if (!attempt?.active) return;
    emit({ ...attempt.fields, stage, elapsed_ms: Math.round(performance.now() - attempt.started), ...fields });
  }

  // Called after ws.send returns, or when a closed socket skips the write.
  // "forwarded" means queued on the daemon socket, not accepted by the agent.
  sent(socket: object, message: any, queued: boolean): void {
    const attempt = this.attempts.getStore();
    if (!attempt?.active) return;
    const transport = queued ? 'queued' : 'socket_not_open';
    if (socket !== attempt.client && message.type === 'user_message') {
      attempt.outcome = queued ? 'forwarded' : 'forward_skipped';
      this.record(attempt.outcome, { transport });
    } else if (socket === attempt.client) {
      if (message.type === 'user_message_nack' || message.type === 'error') {
        attempt.outcome = 'rejected';
        this.record('rejected', {
          reason: identifier(message.reason) ?? identifier(message.code) ?? 'routing_denied',
          retryable: typeof message.retryable === 'boolean' ? message.retryable : null, transport,
        });
      } else if (message.type === 'user_message_ack') {
        if (message.reason === 'request_in_progress') attempt.outcome = 'duplicate';
        this.record('ack', { reason: identifier(message.reason), transport });
      }
    }
  }
}

export function logMessageReceipt(userId: number | null, daemonId: string, message: any): void {
  emit({
    stage: 'receipt_received', user_id: userId, daemon_id: identifier(daemonId),
    session_id: identifier(message.session_id), request_id: identifier(message.request_id),
    msg_id: identifier(message.msg_id),
    status: message.status === 'accepted' || message.status === 'rejected' ? message.status : 'unknown',
    reason: identifier(message.reason),
    retryable: typeof message.retryable === 'boolean' ? message.retryable : null,
  });
}
