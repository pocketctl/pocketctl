import type { MaterializationContext } from '../materialization/types.js';

export type PriorityClass = 'control' | 'live' | 'replay' | 'aggregate';

export interface IngressEnvelope {
  userId: number | null;
  daemonId: string;
  registrationId: string;
  daemonGeneration: number;
  seq: number;
  dedupKey: string;
  sessionId: string | null;
  eventType: string;
  priority: PriorityClass;
  receiptOnly?: boolean;
  payload: Record<string, unknown>;
  materializationContext: MaterializationContext;
  receivedAt: Date;
}

export interface AckCheckpoint {
  daemonId: string;
  daemonGeneration: number;
  ackSeq: number;
}

export interface FlowControlState {
  window: number;
  retryAfterMs: number;
  reason: 'normal' | 'ingest_backpressure' | 'worker_backlog' | 'relay_overloaded' | 'event_too_large';
  blockedSeq?: number;
}
