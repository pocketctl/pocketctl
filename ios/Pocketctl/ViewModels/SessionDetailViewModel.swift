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

    let session: Session
    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var msgCounter = 0
    private var eventListenerId: String?

    init(session: Session, wsService: WebSocketService, apiClient: APIClient) {
        self.session = session
        self.status = session.status
        self.title = session.title
        self.exitReason = session.exitReason
        self.wsService = wsService
        self.apiClient = apiClient
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

    /// Connect and replay history
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

        // Wait for connection to be established (ping verification)
        for _ in 0..<20 {
            if wsService.isConnected { break }
            try? await Task.sleep(for: .milliseconds(200))
        }

        guard wsService.isConnected else {
            isLoading = false
            return
        }

        // Subscribe to this session and replay
        wsService.send(["type": "replay", "session_id": session.sessionId, "last_seq": 0])

        // Wait for replay events to stabilize (500ms of no new messages)
        var stableCount = 0
        var lastCount = -1
        for _ in 0..<60 { // max 6 seconds
            try? await Task.sleep(for: .milliseconds(100))
            if messages.count == lastCount {
                stableCount += 1
                if stableCount >= 5 { break } // 500ms stable
            } else {
                stableCount = 0
            }
            lastCount = messages.count
        }
        isLoading = false
        scrollTick += 1
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
        wsService.send(["type": "replay", "session_id": session.sessionId, "last_seq": 0])

        // Same stabilization logic as connect()
        Task {
            var stableCount = 0
            var lastCount = -1
            for _ in 0..<60 {
                try? await Task.sleep(for: .milliseconds(100))
                if messages.count == lastCount {
                    stableCount += 1
                    if stableCount >= 5 { break }
                } else {
                    stableCount = 0
                }
                lastCount = messages.count
            }
            scrollTick += 1
        }
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
        guard event.sessionId == session.sessionId else { return }

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
        scrollTick += 1
    }

    private func handleUserText(_ event: WebSocketEvent) {
        guard let text = event.text, !text.isEmpty else { return }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .user,
            type: nil,
            content: text,
            streaming: false
        ))
        scrollTick += 1
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
