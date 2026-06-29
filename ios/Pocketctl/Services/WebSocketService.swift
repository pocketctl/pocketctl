import Foundation

/// WebSocket connection to the relay server
final class WebSocketService: @unchecked Sendable {
    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var reconnectAttempt = 0
    private var reconnectTimer: Timer?
    private var isConnectedInternal = false
    private var isReconnectingInternal = false
    private var currentURL: String?
    private var currentToken: String?

    var isConnected: Bool { isConnectedInternal }
    var isReconnecting: Bool { isReconnectingInternal }

    /// Daemon tracking
    var daemons: [String: Daemon] = [:]

    /// Available models keyed by `"<daemonId>:<agent>"` (populated by model_list
    /// events). The daemon answers `list_models` per-agent (Claude reads
    /// ~/.claude/settings.json, codex returns its own list, opencode queries its
    /// serve API), so the cache must be scoped per agent — otherwise switching
    /// agent would show the wrong (stale) list.
    var availableModels: [String: [ModelOption]] = [:]

    /// Builds the cache key shared by `requestModels` and the `model_list` handler.
    static func modelsKey(daemonId: String, agent: String) -> String {
        "\(daemonId):\(agent)"
    }

    /// Event callbacks — multiple listeners supported
    private var eventListeners: [String: ([String: Any]) -> Void] = [:]
    private var listenerCounter = 0

    /// Register an event listener, returns a cleanup ID
    func addEventListener(_ handler: @escaping ([String: Any]) -> Void) -> String {
        listenerCounter += 1
        let id = "listener_\(listenerCounter)"
        eventListeners[id] = handler
        return id
    }

    /// Remove an event listener by ID
    func removeEventListener(_ id: String) {
        eventListeners.removeValue(forKey: id)
    }

    /// Legacy single callback (deprecated, use addEventListener)
    var onEvent: (([String: Any]) -> Void)? {
        get { nil }
        set {
            if let handler = newValue {
                _ = addEventListener(handler)
            }
        }
    }

    /// Auth failure callback — fired when relay rejects the token (4001)
    var onAuthFailure: (() -> Void)?

    /// Connect to the relay WebSocket (fire-and-forget, used by reconnects).
    /// - Parameters:
    ///   - url: WebSocket URL（可选，不传则使用 RelayEnvironmentManager 的默认环境 URL）
    ///   - token: 认证 Token
    func connect(url: String? = nil, token: String) {
        currentURL = url
        currentToken = token

        let resolvedURL = url ?? RelayEnvironmentManager.shared.current.wsBaseURL
        let fullURL = "\(resolvedURL)?type=client&token=\(token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token)"
        guard openWebSocket(fullURL: fullURL) else { return }

        isReconnectingInternal = false
        reconnectAttempt = 0

        // Send a ping to verify connection is actually accepted
        webSocket?.sendPing { [weak self] error in
            guard let self else { return }
            DispatchQueue.main.async {
                if error != nil {
                    // Connection rejected — likely auth failure (4001)
                    self.handleAuthFailure()
                } else {
                    self.onPingSuccess()
                }
            }
        }
    }

    /// Async connect that resolves once the WebSocket handshake (ping) completes.
    /// Replaces the caller-side `for _ in 0..<20 { sleep 200ms }` poll loop —
    /// the connection is driven by the ping callback, so there is no fixed-step
    /// delay between the socket coming up and the replay request being sent.
    /// - Returns: `true` if the handshake succeeded, `false` on auth failure.
    @discardableResult
    func connectAsync(url: String? = nil, token: String) async -> Bool {
        currentURL = url
        currentToken = token

        let resolvedURL = url ?? RelayEnvironmentManager.shared.current.wsBaseURL
        let fullURL = "\(resolvedURL)?type=client&token=\(token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token)"
        guard openWebSocket(fullURL: fullURL) else { return false }

        isReconnectingInternal = false
        reconnectAttempt = 0

        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            // Capture locally so the resume happens exactly once regardless of
            // whether the ping or a deinit-race fires the callback.
            webSocket?.sendPing { [weak self] error in
                let ok = (error == nil)
                DispatchQueue.main.async {
                    guard let self else { continuation.resume(returning: false); return }
                    if ok {
                        self.onPingSuccess()
                    } else {
                        self.handleAuthFailure()
                    }
                    continuation.resume(returning: ok)
                }
            }
        }
    }

    /// Create the URLSession + WebSocket task and resume it (shared by the
    /// sync and async connect entry points).
    @discardableResult
    private func openWebSocket(fullURL: String) -> Bool {
        guard let wsURL = URL(string: fullURL) else { return false }
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)
        webSocket = session?.webSocketTask(with: wsURL)
        webSocket?.resume()
        return true
    }

    /// Shared post-handshake wiring: flip the connected flag, report UI locale
    /// (so relay generates language-aware auto titles — mirrors web's
    /// set_locale; see useWebSocket.ts), and start the receive loop.
    private func onPingSuccess() {
        isConnectedInternal = true
        let locale = Locale.current.language.languageCode?.identifier ?? "zh"
        send(["type": "set_locale", "locale": locale])
        DispatchQueue.global().async { [weak self] in
            self?.receiveLoop()
        }
    }

    /// Send a JSON message
    func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(string)) { _ in }
    }

    /// Request available models for a daemon (response arrives via model_list
    /// event, stored in `availableModels` under `"<daemonId>:<agent>"`).
    /// `agent` selects the daemon's model source (Claude settings.json / codex
    /// list / opencode serve API) — mirroring web's `list_models` payload.
    func requestModels(daemonId: String, agent: String) {
        send([
            "type": "list_models",
            "daemon_id": daemonId,
            "agent": agent,
        ])
    }

    /// Disconnect
    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        isConnectedInternal = false
        isReconnectingInternal = false
    }

    // MARK: - Private

    private func receiveLoop() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                DispatchQueue.main.async { [weak self] in
                    self?.handleDisconnect()
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Track daemon status internally
        if let type = dict["type"] as? String, type == "daemon_status",
           let daemonId = dict["daemon_id"] as? String {
            if let daemon = Daemon.from(event: dict) {
                daemons[daemonId] = daemon
            }
        }

        // NOTE: model_list is host-level and may omit daemon_id (relay forwards the
        // daemon's reply verbatim) and never carries `agent`. The owning view
        // (NewSessionSheet) knows which agent it requested, so it writes the
        // per-agent cache entry under "<daemonId>:<agent>" itself — we only fan the
        // event out to listeners here.

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for (_, handler) in self.eventListeners {
                handler(dict)
            }
        }
    }

    private func handleDisconnect() {
        isConnectedInternal = false
        isReconnectingInternal = true

        let delay = min(pow(2.0, Double(reconnectAttempt)), 30.0)
        reconnectAttempt += 1

        // If too many attempts, trigger auth failure for token refresh
        if reconnectAttempt > 3 {
            DispatchQueue.main.async { [weak self] in
                self?.handleAuthFailure()
            }
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let url = self.currentURL, let token = self.currentToken else { return }
            self.connect(url: url, token: token)
        }
    }

    /// Auth failure — relay rejected token or too many reconnect attempts
    private func handleAuthFailure() {
        isConnectedInternal = false
        isReconnectingInternal = false
        reconnectAttempt = 0
        onAuthFailure?()
    }

    /// Check if a daemon is online
    func isDaemonOnline(_ daemonId: String) -> Bool {
        daemons[daemonId]?.online ?? false
    }

    /// Get effective session status (overrides to "disconnected" if daemon offline)
    func effectiveStatus(for session: Session) -> String {
        if !isDaemonOnline(session.daemonId) && !session.isTerminal {
            return "disconnected"
        }
        return session.status
    }
}
