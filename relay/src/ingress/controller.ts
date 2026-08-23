import { buildDedupKey, classifyDaemonEvent, normalizeSessionId } from './event-policy.js'
import { FairIngressQueue, type EnqueueResult } from './fair-queue.js'
import type { InboxRepository } from './inbox-repository.js'
import type { AckCheckpoint, FlowControlState, IngressEnvelope } from './types.js'
import type { MaterializationContext } from '../materialization/types.js'
import { ackLatency, ingressBatchSize, ingressEvents, ingressQueueDepth } from '../metrics.js'

export interface IngressConnection {
  daemonId: string;
  registrationId: string;
  userId: number | null;
  daemonGeneration: number;
}

export type IngressTarget = IngressConnection;

export type AcceptResult = EnqueueResult | { kind: 'ephemeral' };

export interface IngressControllerDependencies {
  repository: Pick<InboxRepository, 'persistBatch'>;
  sendAck(daemonId: string, checkpoint: AckCheckpoint, window: number): void;
  sendFlowControl?(target: IngressTarget, state: FlowControlState): void;
  disconnectRetryable(target: IngressTarget, reason: string, retryAfterMs: number): void;
  queue?: FairIngressQueue;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  flushDelayMs?: number;
  retryDelayMs?: number;
}

export function checkpointKey(daemonId: string, daemonGeneration: number): string {
  return `${daemonId}\0${daemonGeneration}`
}

/**
 * Commits durable envelopes to the Inbox before advertising their contiguous
 * watermark. It intentionally does not materialize normal session events: the
 * P2 worker owns that separate responsibility.
 */
export class IngressController {
  private readonly queue: FairIngressQueue;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly flushDelayMs: number;
  private readonly retryDelayMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private accepting = true;
  private ackEnabled = true;
  private stopDeadlineExceeded = false;
  private retryAfterDrain = false;

  constructor(private readonly dependencies: IngressControllerDependencies) {
    this.queue = dependencies.queue ?? new FairIngressQueue();
    this.now = dependencies.now ?? (() => new Date());
    this.setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
    this.flushDelayMs = Math.max(5, Math.min(10, dependencies.flushDelayMs ?? 5));
    this.retryDelayMs = Math.max(1, dependencies.retryDelayMs ?? 25);
  }

  start(): void { this.scheduleFlush(this.flushDelayMs); }

  accept(
    connection: IngressConnection,
    payload: Record<string, unknown>,
    materializationContext: MaterializationContext = {},
  ): AcceptResult {
    const policy = classifyDaemonEvent(payload);
    const seq = Number(payload.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0) return { kind: 'ephemeral' };
    if (!this.accepting) return { kind: 'backpressured', state: this.stopState() };
    const envelope: IngressEnvelope = {
      userId: connection.userId,
      daemonId: connection.daemonId,
      registrationId: connection.registrationId,
      daemonGeneration: connection.daemonGeneration,
      seq,
      dedupKey: buildDedupKey(connection.daemonId, connection.daemonGeneration, seq, payload),
      sessionId: normalizeSessionId(payload.session_id),
      eventType: String(payload.type ?? ''),
      priority: policy.priority,
      receiptOnly: !policy.durable,
      payload,
      materializationContext,
      receivedAt: this.now(),
    };
    const result = this.queue.enqueue(envelope);
    ingressEvents.inc({ priority: policy.priority, result: result.kind })
    ingressQueueDepth.set(this.queue.size)
    if (result.kind === 'accepted') this.scheduleFlush(this.flushDelayMs);
    return result;
  }

  async flushNow(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.clearScheduledFlush();
    const run = this.drain().catch((error: unknown) => {
      console.error('durable ingress drain failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    });
    this.flushing = run;
    void run.finally(() => {
      if (this.flushing === run) this.flushing = undefined;
      if (!this.accepting || this.queue.size === 0) return;
      const delay = this.retryAfterDrain ? this.retryDelayMs : 0;
      this.retryAfterDrain = false;
      this.scheduleFlush(delay);
    });
    return run;
  }

  async stop(options: { flushDeadlineMs: number }): Promise<void> {
    this.accepting = false;
    this.clearScheduledFlush();
    const flush = this.flushNow();
    const deadlineMs = Math.max(0, Math.trunc(options.flushDeadlineMs));
    let timedOut = false;
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        const timer = this.setTimer(() => {
          timedOut = true;
          this.ackEnabled = false;
          this.stopDeadlineExceeded = true;
          resolve();
        }, deadlineMs);
        flush.finally(() => this.clearTimer(timer));
      }),
    ]);
    if (timedOut) this.ackEnabled = false;
  }

  private async drain(): Promise<void> {
    while (this.queue.size > 0 && !this.stopDeadlineExceeded) {
      const batch = this.queue.takeBatch({ maxRows: 256, maxBytes: 1 << 20, maxPerDaemonFraction: 0.25 });
      if (batch.length === 0) return;
      ingressBatchSize.observe(batch.length)
      ingressQueueDepth.set(this.queue.size)
      let checkpoints: Map<string, AckCheckpoint>;
      try {
        checkpoints = await this.dependencies.repository.persistBatch(batch);
      } catch (error) {
        this.queue.requeueFront(batch);
        const state: FlowControlState = { window: 1, retryAfterMs: this.retryDelayMs, reason: 'ingest_backpressure' };
        for (const target of this.batchTargets(batch).values()) {
          this.dependencies.sendFlowControl?.(target, state);
        }
        this.retryAfterDrain = true;
        console.error('durable ingress persist:', error);
        return;
      }
      this.queue.commitBatch(batch);
      ingressQueueDepth.set(this.queue.size)
      const ackedAt = this.now().getTime()
      for (const event of batch) ackLatency.observe(Math.max(0, (ackedAt - event.receivedAt.getTime()) / 1000))
      if (this.ackEnabled) {
        for (const checkpoint of checkpoints.values()) {
          try {
            this.dependencies.sendAck(checkpoint.daemonId, checkpoint, 128);
          } catch (error) {
            console.error('durable ingress ack callback failed', {
              daemonId: checkpoint.daemonId,
              daemonGeneration: checkpoint.daemonGeneration,
              errorName: error instanceof Error ? error.name : 'unknown',
            });
          }
        }
      }
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.accepting || this.timer || this.flushing || this.queue.size === 0) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flushNow();
    }, delayMs);
  }

  private clearScheduledFlush(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private stopState(): FlowControlState {
    return { window: 1, retryAfterMs: 250, reason: 'relay_overloaded' };
  }

  private batchTargets(batch: readonly IngressEnvelope[]): Map<string, IngressTarget> {
    const targets = new Map<string, IngressTarget>();
    for (const event of batch) {
      const key = `${event.daemonId}\0${event.registrationId}\0${event.daemonGeneration}`;
      targets.set(key, {
        daemonId: event.daemonId,
        registrationId: event.registrationId,
        userId: event.userId,
        daemonGeneration: event.daemonGeneration,
      });
    }
    return targets;
  }
}
