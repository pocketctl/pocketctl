export interface TeamSubscriptionAuthorizer {
  sharedHighWater?(userId:number,sessionId:string):Promise<number>
  canSubscribe(userId: number, sessionId: string): Promise<boolean>
}

export interface TeamSubscriptionNotifier {
  event(sessionId: string, participantUserIds: number[], event: unknown): void
  revoked(sessionId: string, userId: number): void
}
