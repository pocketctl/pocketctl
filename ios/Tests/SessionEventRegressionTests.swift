import Foundation

// Compile with its direct model and policy sources; `swift` alone cannot load
// these application types from this standalone regression file.
@main
struct SessionEventRegressionTests {
    static func main() {
        testReplayAndLiveCopiesAreAcceptedOnce()
        testDistinctRepeatedMessagesArePreserved()
        testAdjacentAgentCopiesAreCollapsed()
        testLiveSessionGetsSortableTimestamp()
        testFirstPageDoesNotDropNewLiveSession()
        testCompletedDaemonSessionCanContinue()
        testOfflineWritableStatusesRequireDaemon()
        testClaudeTerminalContinuationCapabilities()
        testAcceptedSendIsImmediatelyWorking()
        testAcknowledgmentKeepsAwaitingState()
        testRunningStatusTakesOverWithoutGap()
        testTerminalStatusAndRejectionClearAwaitingState()
        testResetClearsAwaitingState()
        testRemapBeforePageCanonicalizesIncomingId()
        testRemapAfterPageCollapsesDuplicateIds()
        testCanonicalEntryWinsDuplicateCollision()
        testChainedSessionIdRemapsReachFinalId()
        testReconnectDiscoveryIsNotFresh()
        testCodexChildUsesExistingSessionChildrenModel()
        print("SessionEventRegressionTests passed")
    }

    private static func testCodexChildUsesExistingSessionChildrenModel() {
        let session = Session.from(dict: [
            "session_id": "root",
            "daemon_id": "daemon-1",
            "agent_type": "codex",
            "source": "daemon",
            "status": "completed",
            "children": [[
                "agentId": "child",
                "kind": "codex_subagent",
                "agentType": "codex",
                "title": "Newton",
                "status": "completed",
            ]],
        ])

        expect(session?.children.count == 1,
               "Codex child should use the existing children model")
        expect(session?.children.first?.agentId == "child",
               "Codex child id should be preserved")
        expect(session?.children.first?.agentType == "codex",
               "Codex child should preserve the existing badge type")
        expect(SessionInputPolicy.canSend(
            status: "completed",
            source: "daemon",
            daemonOnline: true,
            isSubagent: false
        ), "a parent with Codex children must remain writable")
    }

    private static func testReconnectDiscoveryIsNotFresh() {
        expect(!SessionDiscoveryPolicy.isFresh([
            "type": "session_discovered",
            "resync": true,
        ]), "reconnect resync must not be treated as fresh")
        expect(SessionDiscoveryPolicy.isFresh([
            "type": "session_discovered",
        ]), "normal discovery remains fresh")
    }

    private static func testRemapBeforePageCanonicalizesIncomingId() {
        var identity = SessionIdentityCanonicalizer()
        identity.record(oldId: "pending-1", newId: "real-1")

        let canonical = identity.canonicalize([
            makeSession(id: "pending-1", timestamp: "2026-07-10T02:00:00Z")
        ])

        expect(canonical.map(\.sessionId) == ["real-1"],
               "a stale first page id should canonicalize to the remapped id")
    }

    private static func testRemapAfterPageCollapsesDuplicateIds() {
        var identity = SessionIdentityCanonicalizer()
        identity.record(oldId: "pending-1", newId: "real-1")

        let canonical = identity.canonicalize([
            makeSession(id: "pending-1", timestamp: "2026-07-10T01:00:00Z"),
            makeSession(id: "real-1", timestamp: "2026-07-10T02:00:00Z"),
        ])

        expect(canonical.count == 1 && canonical[0].sessionId == "real-1",
               "old and new entries should collapse to one canonical session")
    }

    private static func testCanonicalEntryWinsDuplicateCollision() {
        var identity = SessionIdentityCanonicalizer()
        identity.record(oldId: "pending-1", newId: "real-1")
        var canonicalEntry = makeSession(id: "real-1", timestamp: "2026-07-10T02:00:00Z")
        canonicalEntry.title = "authoritative"
        var staleEntry = makeSession(id: "pending-1", timestamp: "2026-07-10T01:00:00Z")
        staleEntry.title = "stale"

        let canonical = identity.canonicalize([canonicalEntry, staleEntry])

        expect(canonical.count == 1 && canonical[0].title == "authoritative",
               "the entry already using the canonical id should win")
    }

    private static func testChainedSessionIdRemapsReachFinalId() {
        var identity = SessionIdentityCanonicalizer()
        identity.record(oldId: "pending-1", newId: "intermediate-1")
        identity.record(oldId: "intermediate-1", newId: "real-1")

        expect(identity.canonicalId("pending-1") == "real-1",
               "chained remaps should resolve to the final id")
        expect(identity.canonicalize(Set(["pending-1", "real-1"])) == Set(["real-1"]),
               "live ids should deduplicate after canonicalization")
    }

    private static func testAcceptedSendIsImmediatelyWorking() {
        var state = TurnActivityState()
        state.apply(.sendAccepted)
        expect(state.isAwaitingStart, "an accepted send should await model start")
        expect(state.isWorking(status: "completed"), "awaiting should show working over completed status")
    }

    private static func testAcknowledgmentKeepsAwaitingState() {
        var state = TurnActivityState()
        state.apply(.sendAccepted)
        state.apply(.acknowledged)
        expect(state.isAwaitingStart, "relay ack must not end the working indicator")
    }

    private static func testRunningStatusTakesOverWithoutGap() {
        var state = TurnActivityState()
        state.apply(.sendAccepted)
        let before = state.isWorking(status: "completed")
        state.apply(.status("running"))
        expect(before && state.isWorking(status: "running"), "running status should take over without a gap")
        expect(!state.isAwaitingStart, "authoritative running status should clear transient awaiting")
    }

    private static func testTerminalStatusAndRejectionClearAwaitingState() {
        var terminal = TurnActivityState()
        terminal.apply(.sendAccepted)
        terminal.apply(.status("completed"))
        expect(!terminal.isWorking(status: "completed"), "terminal status should stop working")

        var rejected = TurnActivityState()
        rejected.apply(.sendAccepted)
        rejected.apply(.rejected)
        expect(!rejected.isWorking(status: "completed"), "nack should stop working")
    }

    private static func testResetClearsAwaitingState() {
        var state = TurnActivityState()
        state.apply(.sendAccepted)
        state.apply(.reset)
        expect(!state.isWorking(status: "completed"), "detail reconnect should clear awaiting")
    }

    private static func testCompletedDaemonSessionCanContinue() {
        expect(SessionInputPolicy.canSend(
            status: "completed",
            source: "daemon",
            daemonOnline: true,
            isSubagent: false
        ), "a completed daemon session should keep the input available")
        expect(!SessionInputPolicy.canSend(
            status: "completed",
            source: "terminal",
            daemonOnline: true,
            isSubagent: false
        ), "a terminal session should remain read-only")
        expect(SessionInputPolicy.canSend(
            status: "completed",
            source: "terminal",
            daemonOnline: true,
            isSubagent: false,
            isManagedSession: true
        ), "a managed terminal session should remain writable after completion")
        expect(!SessionInputPolicy.canSend(
            status: "completed",
            source: "terminal",
            daemonOnline: false,
            isSubagent: false,
            isManagedSession: true
        ), "a managed terminal session cannot continue while its daemon is offline")
        expect(!SessionInputPolicy.canSend(
            status: "completed",
            source: "daemon",
            daemonOnline: false,
            isSubagent: false
        ), "a completed daemon session cannot continue while its daemon is offline")
    }

    private static func testOfflineWritableStatusesRequireDaemon() {
        for status in ["idle", "waiting_approval"] {
            expect(!SessionInputPolicy.canSend(
                status: status,
                source: "daemon",
                daemonOnline: false,
                isSubagent: false
            ), "an offline \(status) session must not remain writable")
            expect(SessionInputPolicy.canSend(
                status: status,
                source: "daemon",
                daemonOnline: true,
                isSubagent: false
            ), "an online \(status) session should remain writable")
        }
    }

    private static func testClaudeTerminalContinuationCapabilities() {
        let capabilities: Set<String> = ["history_sync", "resume_after_exit"]
        for status in ["running", "busy", "waiting", "waiting_approval"] {
            expect(!SessionInputPolicy.canSend(
                status: status,
                source: "terminal",
                daemonOnline: true,
                isSubagent: false,
                agentType: "claude-code",
                capabilities: capabilities
            ), "terminal Claude must remain read-only while \(status)")
        }
        expect(SessionInputPolicy.canSend(
            status: "idle",
            source: "terminal",
            daemonOnline: true,
            isSubagent: false,
            agentType: "claude-code",
            capabilities: capabilities
        ), "idle terminal Claude should allow handoff")
        for status in ["exited", "completed", "error", "killed"] {
            expect(SessionInputPolicy.canSend(
                status: status,
                source: "terminal",
                daemonOnline: true,
                isSubagent: false,
                agentType: "claude-code",
                capabilities: capabilities
            ), "terminal Claude should resume from \(status) with capability")
            expect(!SessionInputPolicy.canSend(
                status: status,
                source: "terminal",
                daemonOnline: true,
                isSubagent: false,
                agentType: "claude-code",
                capabilities: ["history_sync"]
            ), "terminal Claude should fail closed without resume capability")
        }
        expect(SessionInputPolicy.canSend(
            status: "running",
            source: "daemon",
            daemonOnline: true,
            isSubagent: false,
            agentType: "claude-code"
        ), "daemon-owned Claude PTY should preserve current input behavior")
    }

    private static func testAdjacentAgentCopiesAreCollapsed() {
        let messages = [ChatMessage(
            id: 1,
            role: .agent,
            type: .agentText,
            content: "done",
            streaming: false
        )]

        expect(MessageAppendPolicy.isImmediateDuplicate(
            role: .agent,
            type: .agentText,
            content: "done",
            in: messages
        ), "adjacent copies of the same agent reply should be collapsed")
        expect(!MessageAppendPolicy.isImmediateDuplicate(
            role: .agent,
            type: .agentText,
            content: "another reply",
            in: messages
        ), "different agent replies should be preserved")
    }

    private static func testReplayAndLiveCopiesAreAcceptedOnce() {
        var deduplicator = EventDeliveryDeduplicator()
        let event: [String: Any] = [
            "type": "agent_text",
            "session_id": "session-1",
            "seq": 42,
            "text": "done",
        ]

        expect(deduplicator.shouldAccept(event), "first delivery should be accepted")
        expect(!deduplicator.shouldAccept(event), "replay/live copy with the same sequence should be rejected")
    }

    private static func testDistinctRepeatedMessagesArePreserved() {
        var deduplicator = EventDeliveryDeduplicator()
        let first: [String: Any] = [
            "type": "user_text",
            "session_id": "session-1",
            "seq": 42,
            "text": "retry",
        ]
        let second: [String: Any] = [
            "type": "user_text",
            "session_id": "session-1",
            "seq": 43,
            "text": "retry",
        ]

        expect(deduplicator.shouldAccept(first), "first message should be accepted")
        expect(deduplicator.shouldAccept(second), "a separate event with identical text should be preserved")
    }

    private static func testLiveSessionGetsSortableTimestamp() {
        let now = "2026-07-10T02:00:00Z"
        let session = Session.fromLiveEvent(
            dict: [
                "type": "session_created",
                "session_id": "new-session",
                "daemon_id": "daemon-1",
                "status": "running",
            ],
            fallbackDaemonId: "daemon-1",
            now: now
        )

        expect(session?.createdAt == now, "live session should receive a created_at fallback")
        expect(session?.lastActivityAt == now, "live session should receive a last_activity_at fallback")
    }

    private static func testFirstPageDoesNotDropNewLiveSession() {
        let live = makeSession(id: "new-session", timestamp: "2026-07-10T02:00:00Z")
        let remote = makeSession(id: "old-session", timestamp: "2026-07-09T02:00:00Z")

        let merged = SessionPageMergePolicy.merge(
            existing: [live],
            incoming: [remote],
            replaceAll: true,
            preserveSessionIds: [live.sessionId]
        )

        expect(merged.map(\.sessionId) == [live.sessionId, remote.sessionId],
               "the first remote page should preserve a concurrently-created live session")
    }

    private static func makeSession(id: String, timestamp: String) -> Session {
        Session(
            sessionId: id,
            daemonId: "daemon-1",
            agentType: "codex",
            cwd: "/tmp",
            source: "daemon",
            status: "running",
            createdAt: timestamp,
            lastActivityAt: timestamp,
            subagentCount: 0,
            daemonOnline: true
        )
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }
}
