export interface TeamSubscriptionAuthorizer {
  canSubscribe(userId: number, sessionId: string): Promise<boolean>
}

export interface TeamSubscriptionNotifier {
  event(sessionId: string, participantUserIds: number[], event: unknown): void
  revoked(sessionId: string, userId: number): void
}
