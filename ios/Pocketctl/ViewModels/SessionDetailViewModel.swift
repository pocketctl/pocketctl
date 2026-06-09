import Foundation

@Observable
@MainActor
final class SessionDetailViewModel {
    var messages: [ChatMessage] = []
    var subAgents: [String: SubAgent] = [:]
    var status: String
    var title: String?
    var exitReason: String?
    var isLoading = true
    /// Incremented when initial replay completes — triggers scroll-to-bottom
    var scrollTick = 0

    var session: Session  // var to support session_id_changed updates
    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var msgCounter = 0
    private var eventListenerId: String?
    /// Tracks the last event sequence number for incremental replay
    private var lastEventSeq: Int = 0
    /// True while processing a replay_batch — suppresses per-event scrollTick updates
    private var isBatchProcessing = false

    init(session: Session, wsService: WebSocketService, apiClient: APIClient) {
        self.session = session
        self.status = session.status
        self.title = session.title
        self.exitReason = session.exitReason
        self.wsService = wsService
        self.apiClient = apiClient
        self.lastEventSeq = Self.loadLastSeq(for: session.sessionId)
    }

    /// Whether the session is actively executing (running/busy)
    var isExecuting: Bool {
        ["running", "busy"].contains(status)
    }

    /// Whether the input bar should be shown
    var canSendMessage: Bool {
        if status == "exited" && wsService.isDaemonOnline(session.daemonId) { return true }
        return ["idle", "waiting_approval"].contains(status)
    }

    var inputPlaceholder: String {
        if status == "exited" { return "输入消息以恢复 Session..." }
        return "发送消息..."
    }

    // MARK: - Connect / Refresh

    /// Connect and replay history using incremental replay.
    /// No polling — relay sends `replay_end` when done.
    func connect() async {
        guard KeychainStorage.accessToken != nil else { return }

        // Refresh token before connecting
        var token: String
        if let refreshToken = KeychainStorage.refreshToken {
            if let resp = try? await apiClient.refreshToken(refreshToken) {
                KeychainStorage.accessToken = resp.access_token
                KeychainStorage.refreshToken = resp.refresh_token
                token = resp.access_token
            } else {
                guard let t = KeychainStorage.accessToken else { return }
                token = t
            }
        } else {
            guard let t = KeychainStorage.accessToken else { return }
            token = t
        }

        let wsURL = apiClient.baseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
            + "/ws"

        eventListenerId = wsService.addEventListener { [weak self] dict in
            self?.handleEvent(dict)
        }

        if !wsService.isConnected {
            wsService.connect(url: wsURL, token: token)
        }

        // Wait for WebSocket connection (ping verification)
        for _ in 0..<20 {
            if wsService.isConnected { break }
            try? await Task.sleep(for: .milliseconds(200))
        }

        guard wsService.isConnected else {
            isLoading = false
            return
        }

        // Incremental replay: only load events after lastEventSeq
        wsService.send([
            "type": "replay",
            "session_id": session.sessionId,
            "last_seq": lastEventSeq,
        ])
        // isLoading will be set to false when replay_end arrives

        // Safety timeout: if replay_end never arrives (network drop, relay crash),
        // unblock the UI after 10 seconds so the user isn't stuck forever.
        Task {
            try? await Task.sleep(for: .seconds(10))
            if isLoading {
                isLoading = false
                scrollTick += 1
            }
        }
    }

    func disconnect() {
        if let id = eventListenerId {
            wsService.removeEventListener(id)
            eventListenerId = nil
        }
    }

    /// Re-register event handler and replay session history.
    /// Called on .onAppear when returning to this view.
    func refresh() {
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                self?.handleEvent(dict)
            }
        }
        // Clear and do full replay
        messages.removeAll(keepingCapacity: true)
        subAgents.removeAll(keepingCapacity: true)
        msgCounter = 0
        lastEventSeq = 0

        wsService.send([
            "type": "replay",
            "session_id": session.sessionId,
            "last_seq": 0,
        ])
        // isLoading set to false by replay_end
    }

    /// Send a user message (will appear when relay echoes it back as userText)
    func sendMessage(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        wsService.send([
            "type": "user_message",
            "session_id": session.sessionId,
            "content": text,
        ])
    }

    // MARK: - Event handling

    private func handleEvent(_ dict: [String: Any]) {
        guard let event = WebSocketEvent(dict: dict) else { return }

        // ── Replay control events (no session ID filter) ──

        if event.type == .replayBatch {
            isBatchProcessing = true
            if let batchEvents = event.events {
                for evtDict in batchEvents {
                    handleEvent(evtDict)
                }
            }
            if let seq = event.lastSeq {
                lastEventSeq = seq
            }
            isBatchProcessing = false
            scrollTick += 1
            return
        }

        if event.type == .replayEnd {
            if let seq = event.lastSeq {
                lastEventSeq = seq
                Self.saveLastSeq(seq, for: session.sessionId)
            }
            isLoading = false
            scrollTick += 1
            return
        }

        // ── Session ID change (must be handled before the filter) ──

        if event.type == .sessionIdChanged {
            if let newId = event.sessionId,
               let oldId = dict["old_session_id"] as? String,
               oldId == session.sessionId {
                // Migrate persisted seq to new ID
                let oldSeq = Self.loadLastSeq(for: oldId)
                Self.saveLastSeq(oldSeq, for: newId)
                Self.removeLastSeq(for: oldId)
                session.sessionId = newId
                lastEventSeq = oldSeq
            }
            return
        }

        // ── Session-scoped events ──
        // Skip session ID filter during batch replay — DB payloads may carry
        // old pre-change session IDs that don't match the current session.
        if !isBatchProcessing {
            guard event.sessionId == session.sessionId else { return }
        }

        // Sub-agent events
        if let agentId = event.agentId {
            handleSubAgentEvent(agentId: agentId, event: event, dict: dict)
            return
        }

        switch event.type {
        case .agentText:
            handleAgentText(event)

        case .userText:
            handleUserText(event)

        case .toolCall:
            handleToolCall(event, dict: dict)

        case .toolResult:
            handleToolResult(event)

        case .subagentDiscovered:
            handleSubagentDiscovered(event, dict: dict)

        case .sessionStatus:
            status = event.status ?? status
            exitReason = event.exitReason ?? exitReason

        case .sessionTitleUpdate:
            title = event.title

        case .error:
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .error,
                content: event.error ?? "未知错误",
                streaming: false
            ))

        default:
            break
        }
    }

    // MARK: - Individual event handlers

    private func handleAgentText(_ event: WebSocketEvent) {
        guard let text = event.text else { return }

        if event.streaming,
           let last = messages.last,
           last.type == .agentText,
           last.streaming {
            // Append to existing streaming message
            messages[messages.count - 1].content += text
        } else {
            // New message
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .agentText,
                content: text,
                streaming: event.streaming
            ))
        }

        // Mark as complete if not streaming
        if !event.streaming, let last = messages.last, last.streaming {
            messages[messages.count - 1].streaming = false
        }
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleUserText(_ event: WebSocketEvent) {
        guard var text = event.text, !text.isEmpty else { return }

        // Sanitize command tags for clean display
        text = sanitizeUserMessage(text)
        guard !text.isEmpty else { return }

        // Deduplicate: skip if last message has identical content
        if let last = messages.last, last.role == .user, last.content == text {
            return
        }

        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .user,
            type: nil,
            content: text,
            streaming: false
        ))
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleToolCall(_ event: WebSocketEvent, dict: [String: Any]) {
        msgCounter += 1
        let inputDesc = formatToolInput(tool: event.tool, input: event.input)
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .toolCall,
            content: "",
            streaming: false,
            tool: event.tool,
            callId: event.callId,
            inputDescription: inputDesc
        ))
    }

    private func handleToolResult(_ event: WebSocketEvent) {
        guard let callId = event.callId else { return }
        // Find matching tool call (reverse search)
        if let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].output = event.output ?? ""

            // If this is an Agent tool with sub-agent, replace output
            if messages[index].tool == "Agent" && messages[index].subAgentId != nil {
                messages[index].output = "子智能体已完成"
            }
        }
    }

    private func handleSubagentDiscovered(_ event: WebSocketEvent, dict: [String: Any]) {
        guard let agentId = event.agentId else { return }
        let subAgent = SubAgent(
            agentId: agentId,
            description: event.subagentDesc ?? "",
            agentType: event.subagentType ?? "",
            messages: [],
            status: "completed"
        )
        subAgents[agentId] = subAgent

        // Link to parent Agent tool_call
        if let callId = event.callId,
           let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].subAgentId = agentId
        }
    }

    private func handleSubAgentEvent(agentId: String, event: WebSocketEvent, dict: [String: Any]) {
        guard subAgents[agentId] != nil else { return }

        switch event.type {
        case .agentText:
            if let text = event.text {
                var agent = subAgents[agentId]!
                if event.streaming, let last = agent.messages.last, last.streaming {
                    agent.messages[agent.messages.count - 1].content += text
                } else {
                    msgCounter += 1
                    agent.messages.append(ChatMessage(
                        id: msgCounter,
                        role: .agent,
                        type: .agentText,
                        content: text,
                        streaming: event.streaming
                    ))
                }
                if !event.streaming, let last = agent.messages.last, last.streaming {
                    agent.messages[agent.messages.count - 1].streaming = false
                }
                subAgents[agentId] = agent
            }

        case .toolCall:
            var agent = subAgents[agentId]!
            msgCounter += 1
            agent.messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .toolCall,
                content: "",
                streaming: false,
                tool: event.tool,
                callId: event.callId,
                inputDescription: formatToolInput(tool: event.tool, input: event.input)
            ))
            subAgents[agentId] = agent

        case .toolResult:
            var agent = subAgents[agentId]!
            if let callId = event.callId,
               let index = agent.messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
                agent.messages[index].output = event.output ?? ""
            }
            subAgents[agentId] = agent

        default:
            break
        }
    }

    // MARK: - User message sanitization

    /// Sanitize user message content: extract slash command name or strip XML tags
    private func sanitizeUserMessage(_ text: String) -> String {
        // Check if this is a slash command message
        if let cmdName = extractTagContent(text, tag: "command-name") {
            var clean = cmdName
            // Also extract command message if present
            if let cmdMsg = extractTagContent(text, tag: "command-message"), !cmdMsg.isEmpty {
                clean += "\n" + cmdMsg
            }
            return clean
        }

        // Not a command — strip all command-related tags
        return stripAllCommandTags(text)
    }

    /// Extract the inner content of the first occurrence of an XML tag
    private func extractTagContent(_ text: String, tag: String) -> String? {
        let pattern = #"<\#(tag)[^>]*>(.*?)</\#(tag)>"#
        guard let range = text.range(of: pattern, options: .regularExpression) else { return nil }
        let match = String(text[range])
        // Strip all XML tags from the match to get inner content
        let content = match.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return content.isEmpty ? nil : content
    }

    /// Strip all command-related XML tags, keeping the text content
    private func stripAllCommandTags(_ text: String) -> String {
        var result = text
        for tag in ["local-command-caveat", "local-command-stdout", "command-name", "command-message"] {
            result = result.replacingOccurrences(of: #"<\#(tag)[^>]*>"#, with: "", options: .regularExpression)
            result = result.replacingOccurrences(of: #"</\#(tag)>"#, with: "", options: .regularExpression)
        }
        result = result.replacingOccurrences(of: #"<command-args>.*?</command-args>"#, with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Last sequence persistence (UserDefaults)

    private static let seqDefaultsKey = "pocketctl_last_event_seq"

    static func loadLastSeq(for sessionId: String) -> Int {
        let dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        return dict[sessionId] ?? 0
    }

    static func saveLastSeq(_ seq: Int, for sessionId: String) {
        var dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        dict[sessionId] = seq
        UserDefaults.standard.set(dict, forKey: seqDefaultsKey)
    }

    static func removeLastSeq(for sessionId: String) {
        var dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        dict.removeValue(forKey: sessionId)
        UserDefaults.standard.set(dict, forKey: seqDefaultsKey)
    }

    // MARK: - Helpers

    private func formatToolInput(tool: String?, input: Any?) -> String {
        guard let input else { return "" }
        if let dict = input as? [String: Any] {
            switch tool {
            case "Read", "Write", "Edit":
                if let path = dict["file_path"] as? String ?? dict["path"] as? String {
                    let line = dict["offset"] as? Int
                    if let line { return "\(path):\(line)" }
                    return path
                }
            case "Bash":
                if let cmd = dict["command"] as? String {
                    return cmd
                }
            case "Glob", "Grep":
                if let pattern = dict["pattern"] as? String ?? dict["query"] as? String {
                    let path = dict["path"] as? String ?? ""
                    return path.isEmpty ? pattern : "\(pattern) \(path)"
                }
            case "Agent":
                if let prompt = dict["prompt"] as? String {
                    return String(prompt.prefix(60))
                }
            default:
                break
            }
            // Fallback: first string value
            if let first = dict.values.compactMap({ $0 as? String }).first {
                return String(first.prefix(60))
            }
        }
        return String(describing: input).prefix(60).description
    }
}
