export interface MaterializationContext {
  agentType?: string;
  cwd?: string;
  requestId?: string;
  reservationId?: string | null;
  quotaOperation?: 'create' | 'resume';
  hostname?: string;
}

export interface PendingOperationIdentity {
  reservationId: string | null;
  userId: number;
  daemonId: string;
  requestId: string;
  operation: 'create' | 'resume';
  sessionId: string | null;
}

/**
 * Authorization policy for a daemon-provided session id.
 * - must_exist: the session row must already exist and be daemon-owned
 * - allow_create: a missing row is claimable; a foreign row is a violation
 * - allow_missing_status: session_status keeps its ghost-suppression semantics
 */
export type DaemonSessionPolicy = 'must_exist' | 'allow_create' | 'allow_missing_status';

export type DaemonSessionAccess = 'owned' | 'missing';

export interface MaterializationInput {
  inboxId: number;
  userId: number | null;
  daemonId: string;
  sessionId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  /** Relay receipt timestamp from durable ingress; never a daemon wall clock. */
  receivedAt?: Date | null;
  context?: MaterializationContext;
}

export interface DurableMaterializationHooks {
  claimQuotaReservationSession(
    binding: import('../quota.js').QuotaReservationBinding,
  ): Promise<void>;
  /** M-4: settlement requires an explicit outcome; nothing is silently released. */
  settleQuotaReservation(
    binding: import('../quota.js').QuotaReservationBinding,
    reason: 'session_created' | 'session_create_failed' | 'session_active',
  ): Promise<void>;
  notifyUser(userId: number, payload: unknown): Promise<void>;
  notifyProUser(userId: number, payload: unknown): Promise<void>;
}

export interface RuntimeMaterializationHooks {
  bindSession?(sessionId: string, daemonId: string): void;
  renameSession?(oldSessionId: string, sessionId: string, daemonId: string): void;
  prepareSessionCreated?(sessionId: string, daemonId: string, requestId: string | null): void;
  releasePendingOperation?(identity: PendingOperationIdentity): Promise<void>;
  clearPendingSession?(daemonId: string): void;
  broadcastQuota?(userId: number): Promise<void>;
  notifyUser?(userId: number, payload: unknown): Promise<void>;
  notifyProUser?(userId: number, payload: unknown): Promise<void>;
  shouldPush?(requestId: string): boolean;
  forgetPush?(requestId: string): void;
  clearInteractionOrigin?(sessionId: string, requestId: string, operation: string): void;
}

/** @deprecated use RuntimeMaterializationHooks */
export type MaterializationHooks = RuntimeMaterializationHooks;

export interface DurableEffectContext {
  readonly resuming: boolean;
  assertActive(): Promise<void>;
  step(effect: () => Promise<void> | void): Promise<void>;
  atomicStep(effect: (eventID: number, nextStep: number) => Promise<void>): Promise<void>;
}

export type MaterializedAudience = 'session' | 'user' | 'interaction-origin';

export interface MaterializedDelivery {
  inboxId?: number;
  daemonId?: string;
  eventId: number | null;
  userId: number | null;
  audience: MaterializedAudience;
  sessionId: string | null;
  requestId: string | null;
  ordinal: number;
  deliveryKey: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface MaterializationResult {
  eventId: number | null;
  inserted: boolean;
  completed: boolean;
  deliveries: MaterializedDelivery[];
  applyEffects?: () => Promise<void>;
  finalizeEffect?: () => Promise<void>;
}
