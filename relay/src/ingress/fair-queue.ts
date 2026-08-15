import type { FlowControlState, IngressEnvelope, PriorityClass } from './types.js'

// Nine service slots provide a deterministic minimum share to replay and
// aggregate while reserving 7/9 of ready service for latency-sensitive work.
const prioritySchedule: PriorityClass[] = [
  'control', 'control', 'control', 'control',
  'live', 'live', 'live',
  'replay', 'aggregate',
]

export interface FairIngressQueueConfig {
  maxEventsPerDaemon?: number;
  maxBytesPerDaemon?: number;
  maxEvents?: number;
  maxBytes?: number;
  maxEventBytes?: number;
  quantumBytes?: number;
}

export interface BatchLimits {
  maxRows: number;
  maxBytes: number;
  maxPerDaemonFraction: number;
}

export type EnqueueResult =
  | { kind: 'accepted' }
  | { kind: 'backpressured'; state: FlowControlState }

interface QueuedEnvelope {
  event: IngressEnvelope;
  payloadBytes: number;
}

interface DaemonQueue {
  byPriority: Record<PriorityClass, QueuedEnvelope[]>;
  bytes: number;
  count: number;
  deficit: number;
  priorityCursor: number;
}

interface DaemonUsage {
  count: number;
  bytes: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * A bounded ingress queue which keeps daemon work isolated. The active daemon
 * ring has no empty entries, so taking a batch does not degrade as old daemon
 * ids accumulate. Payload JSON is measured exactly once when admitted.
 */
export class FairIngressQueue {
  private readonly maxEventsPerDaemon: number;
  private readonly maxBytesPerDaemon: number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;
  private readonly quantumBytes: number;
  private readonly daemons = new Map<string, DaemonQueue>();
  private readonly usage = new Map<string, DaemonUsage>();
  private readonly activeDaemonIds: string[] = [];
  private readonly activeIndex = new Map<string, number>();
  private readonly cached = new WeakMap<IngressEnvelope, QueuedEnvelope>();
  private readonly reserved = new WeakSet<IngressEnvelope>();
  private nextDaemon = 0;
  private queuedCount = 0;
  private totalCount = 0;
  private totalBytes = 0;

  constructor(config: FairIngressQueueConfig = {}) {
    this.maxEventsPerDaemon = positiveInteger(config.maxEventsPerDaemon, 1_024);
    this.maxBytesPerDaemon = positiveInteger(config.maxBytesPerDaemon, 4 << 20);
    this.maxEvents = positiveInteger(config.maxEvents, 50_000);
    this.maxBytes = positiveInteger(config.maxBytes, 64 << 20);
    this.maxEventBytes = positiveInteger(config.maxEventBytes, 1 << 20);
    this.quantumBytes = positiveInteger(config.quantumBytes, 64 << 10);
  }

  enqueue(event: IngressEnvelope): EnqueueResult {
    const queued = this.toQueued(event);
    if (queued.payloadBytes > Math.min(this.maxEventBytes, this.maxBytesPerDaemon, this.maxBytes)) {
      return {
        kind: 'backpressured',
        state: this.backpressureState('event_too_large', event.seq),
      };
    }
    const daemonUsage = this.usage.get(event.daemonId);
    if (
      (daemonUsage?.count ?? 0) >= this.maxEventsPerDaemon
      || (daemonUsage?.bytes ?? 0) + queued.payloadBytes > this.maxBytesPerDaemon
      || this.totalCount >= this.maxEvents
      || this.totalBytes + queued.payloadBytes > this.maxBytes
    ) return { kind: 'backpressured', state: this.backpressureState() };

    this.insertBack(queued);
    return { kind: 'accepted' };
  }

  requeueFront(events: readonly IngressEnvelope[]): void {
    // Reinsert in reverse order so a failed batch is observed in its original
    // FIFO order. A reserved batch remains charged against capacity after
    // takeBatch, so requeue only restores queue visibility without charging it
    // again or repeating JSON serialization.
    for (let index = events.length - 1; index >= 0; index--) {
      const queued = this.toQueued(events[index]);
      if (!this.reserved.delete(queued.event)) throw new Error('ingress batch is not reserved');
      this.insertFront(queued);
    }
  }

  commitBatch(events: readonly IngressEnvelope[]): void {
    for (const event of events) {
      const queued = this.toQueued(event);
      if (!this.reserved.delete(event)) throw new Error('ingress batch is not reserved');
      const usage = this.usage.get(event.daemonId);
      if (!usage) throw new Error('ingress usage invariant violated');
      usage.count--;
      usage.bytes -= queued.payloadBytes;
      this.totalCount--;
      this.totalBytes -= queued.payloadBytes;
      if (usage.count === 0) this.usage.delete(event.daemonId);
    }
  }

  takeBatch(limits: BatchLimits): IngressEnvelope[] {
    const maxRows = nonNegativeInteger(limits.maxRows, 0);
    const maxBytes = nonNegativeInteger(limits.maxBytes, 0);
    if (maxRows === 0 || maxBytes === 0 || this.activeDaemonIds.length === 0) return [];
    const fraction = Math.max(0, Math.min(1, Number.isFinite(limits.maxPerDaemonFraction) ? limits.maxPerDaemonFraction : 1));
    const perDaemonLimit = Math.max(1, Math.floor(maxRows * fraction));
    const hadReadyPeers = this.activeDaemonIds.length > 1;
    const batch: IngressEnvelope[] = [];
    const perDaemon = new Map<string, number>();
    let bytes = 0;

    // First pass applies the fairness cap. Relax it only when the batch began
    // with one ready daemon; refilling a peer batch from a noisy daemon would
    // make the peers' control ACKs wait for an unnecessarily large write.
    this.drain(batch, perDaemon, maxRows, maxBytes, perDaemonLimit, bytes, false);
    bytes = this.batchBytes(batch);
    if (!hadReadyPeers && batch.length < maxRows) {
      this.drain(batch, perDaemon, maxRows, maxBytes, maxRows, bytes, true);
    }
    return batch;
  }

  get size(): number { return this.queuedCount; }

  private drain(
    batch: IngressEnvelope[],
    perDaemon: Map<string, number>,
    maxRows: number,
    maxBytes: number,
    perDaemonLimit: number,
    initialBytes: number,
    relaxed: boolean,
  ): void {
    let bytes = initialBytes;
    let stalled = 0;
    // A daemon can need several deficits before a large item fits. The bound is
    // proportional to requested rows and active daemons, never historical ids.
    const maxVisits = Math.max(1, maxRows) * Math.max(1, this.activeDaemonIds.length) * 32;
    let visits = 0;
    while (batch.length < maxRows && this.activeDaemonIds.length > 0 && visits++ < maxVisits) {
      const daemonId = this.nextActiveDaemon();
      if (!daemonId) return;
      const daemon = this.daemons.get(daemonId);
      if (!daemon) continue;
      daemon.deficit += this.quantumBytes;
      if ((perDaemon.get(daemonId) ?? 0) >= perDaemonLimit) {
        stalled++;
        if (stalled >= this.activeDaemonIds.length) return;
        continue;
      }
      const queued = this.nextEligible(daemon, maxBytes - bytes);
      if (!queued) {
        stalled++;
        if (stalled >= this.activeDaemonIds.length && (relaxed || batch.length > 0)) return;
        continue;
      }
      stalled = 0;
      this.removeFront(daemonId, daemon, queued.event.priority);
      this.reserved.add(queued.event);
      daemon.deficit -= queued.payloadBytes;
      bytes += queued.payloadBytes;
      batch.push(queued.event);
      perDaemon.set(daemonId, (perDaemon.get(daemonId) ?? 0) + 1);
    }
  }

  private nextEligible(daemon: DaemonQueue, remainingBytes: number): QueuedEnvelope | undefined {
    for (let offset = 0; offset < prioritySchedule.length; offset++) {
      const index = (daemon.priorityCursor + offset) % prioritySchedule.length;
      const priority = prioritySchedule[index];
      const candidate = daemon.byPriority[priority][0];
      if (!candidate) continue;
      if (candidate.payloadBytes > daemon.deficit) continue;
      if (candidate.payloadBytes > remainingBytes) continue;
      daemon.priorityCursor = (index + 1) % prioritySchedule.length;
      return candidate;
    }
    return undefined;
  }

  private toQueued(event: IngressEnvelope): QueuedEnvelope {
    const existing = this.cached.get(event);
    if (existing) return existing;
    const queued = { event, payloadBytes: Buffer.byteLength(JSON.stringify(event.payload), 'utf8') };
    this.cached.set(event, queued);
    return queued;
  }

  private newDaemonQueue(): DaemonQueue {
    return {
      byPriority: { control: [], live: [], replay: [], aggregate: [] },
      bytes: 0,
      count: 0,
      deficit: 0,
      priorityCursor: 0,
    };
  }

  private insertBack(queued: QueuedEnvelope): void {
    const daemon = this.ensureDaemon(queued.event.daemonId);
    daemon.byPriority[queued.event.priority].push(queued);
    this.accountQueuedAdd(daemon, queued.payloadBytes);
    const usage = this.usage.get(queued.event.daemonId) ?? { count: 0, bytes: 0 };
    usage.count++;
    usage.bytes += queued.payloadBytes;
    this.usage.set(queued.event.daemonId, usage);
    this.totalCount++;
    this.totalBytes += queued.payloadBytes;
  }

  private insertFront(queued: QueuedEnvelope): void {
    const daemon = this.ensureDaemon(queued.event.daemonId);
    daemon.byPriority[queued.event.priority].unshift(queued);
    this.accountQueuedAdd(daemon, queued.payloadBytes);
  }

  private ensureDaemon(daemonId: string): DaemonQueue {
    let daemon = this.daemons.get(daemonId);
    if (daemon) return daemon;
    daemon = this.newDaemonQueue();
    this.daemons.set(daemonId, daemon);
    this.activeIndex.set(daemonId, this.activeDaemonIds.length);
    this.activeDaemonIds.push(daemonId);
    return daemon;
  }

  private accountQueuedAdd(daemon: DaemonQueue, bytes: number): void {
    daemon.count++;
    daemon.bytes += bytes;
    this.queuedCount++;
  }

  private removeFront(daemonId: string, daemon: DaemonQueue, priority: PriorityClass): void {
    const queued = daemon.byPriority[priority].shift();
    if (!queued) throw new Error('ingress queue invariant violated');
    daemon.count--;
    daemon.bytes -= queued.payloadBytes;
    this.queuedCount--;
    if (daemon.count === 0) this.removeDaemon(daemonId);
  }

  private removeDaemon(daemonId: string): void {
    const index = this.activeIndex.get(daemonId);
    if (index === undefined) return;
    const last = this.activeDaemonIds.pop();
    this.activeIndex.delete(daemonId);
    this.daemons.delete(daemonId);
    if (last && last !== daemonId) {
      this.activeDaemonIds[index] = last;
      this.activeIndex.set(last, index);
    }
    if (this.activeDaemonIds.length === 0) this.nextDaemon = 0;
    else if (this.nextDaemon > index) this.nextDaemon--;
    this.nextDaemon %= Math.max(1, this.activeDaemonIds.length);
  }

  private nextActiveDaemon(): string | undefined {
    if (this.activeDaemonIds.length === 0) return undefined;
    const index = this.nextDaemon % this.activeDaemonIds.length;
    this.nextDaemon = (index + 1) % this.activeDaemonIds.length;
    return this.activeDaemonIds[index];
  }

  private batchBytes(batch: readonly IngressEnvelope[]): number {
    return batch.reduce((total, event) => total + this.toQueued(event).payloadBytes, 0);
  }

  private backpressureState(
    reason: FlowControlState['reason'] = 'ingest_backpressure',
    blockedSeq?: number,
  ): FlowControlState {
    return {
      window: 1,
      retryAfterMs: reason === 'event_too_large' ? 0 : 25,
      reason,
      ...(blockedSeq === undefined ? {} : { blockedSeq }),
    };
  }
}
