export interface MaterializationContext {
  agentType?: string;
  cwd?: string;
  requestId?: string;
  reservationId?: string | null;
  hostname?: string;
}

export interface MaterializationInput {
  inboxId: number;
  userId: number | null;
  daemonId: string;
  sessionId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  context?: MaterializationContext;
}

export interface DurableMaterializationHooks {
  releaseQuotaReservation(reservationId: string): Promise<void>;
  notifyUser(userId: number, payload: unknown): Promise<void>;
  notifyProUser(userId: number, payload: unknown): Promise<void>;
}

export interface RuntimeMaterializationHooks {
  bindSession?(sessionId: string, daemonId: string): void;
  renameSession?(oldSessionId: string, sessionId: string, daemonId: string): void;
  prepareSessionCreated?(sessionId: string, daemonId: string, requestId: string | null): void;
  releasePendingOperation?(daemonId: string, requestId: string | null): Promise<void>;
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
