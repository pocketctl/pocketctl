import SwiftUI

private enum CreatePhase: Equatable {
    case idle, submitting, connecting
}

/// Drives the bottom-sheet pickers (model / permission) from a single `.sheet(item:)`.
private enum PickerKind: Identifiable {
    case model, permission
    var id: Self { self }
}

/// Measures NewSessionSheet's scrollable content height so the presenting
/// sheet can size its detent to fit (no wasted space under a fixed .large).
private struct NewSessionSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Enhanced new-session sheet (aligns with web `NewSessionDialog`): live model
/// picker from `model_list`, working directory pre-filled from per-daemon-agent
/// defaults, permission-mode selector, three-phase loading, failure banner, and
/// 15s timeout abort. Owns the create lifecycle (send + listen + dismiss).
struct NewSessionSheet: View {
    let daemon: Daemon
    let wsService: WebSocketService
    var onHeightChange: (CGFloat) -> Void = { _ in }
    var onCreated: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var agent = "claude-code"
    @State private var model = ""
    @State private var workdir = "~/"
    @State private var prompt = ""
    @State private var permission = "acceptEdits"
    @State private var phase: CreatePhase = .idle
    @State private var errorText: String?
    @State private var models: [ModelOption] = []
    @State private var eventListenerId: String?
    @State private var timeoutTask: Task<Void, Never>?
    @State private var done = false
    @State private var activePicker: PickerKind?
    // Scheme A/C/D advanced options
    @State private var autoCreateDir = true   // 目录不存在时自动创建
    @State private var worktree = false       // Git Worktree 隔离
    @State private var force = false          // 强制创建（cwd_in_use 确认）
    @State private var showAdvanced = false   // 高级选项展开
    @State private var cwdInUse = false       // 是否处于 cwd_in_use 确认状态

    private var isCreating: Bool { phase != .idle }
    private var canStart: Bool {
        (agent == "claude-code" || agent == "codex") && !prompt.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        ZStack(alignment: .bottom) {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.pcFgTertiary)
                .frame(width: 36, height: 5)
                .padding(.top, 16).padding(.bottom, 16)

            Text("新建会话")
                .font(PCFont.display(20, weight: .semibold))
                .foregroundStyle(Color.pcFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, PCSpacing.xxl)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    agentPills
                    modelPicker
                    cwdField
                    permissionPicker
                    promptField
                    advancedSection
                    if cwdInUse {
                        forceCreateSection
                    }
                    if let errorText {
                        errorBanner(errorText)
                    }

                    Button { start() } label: {
                        Group {
                            if phase == .submitting {
                                HStack(spacing: 6) { ProgressView().tint(.white); Text("正在创建…") }
                            } else if phase == .connecting {
                                HStack(spacing: 6) { ProgressView().tint(.white); Text("正在连接主机…") }
                            } else {
                                Text("开始会话")
                            }
                        }
                        .font(PCFont.display(17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                        .background(canStart ? Color.pcPrimaryBtn : Color.pcFgTertiary)
                        .cornerRadius(PCRadius.md)
                    }
                    .disabled(!canStart || isCreating)
                }
                .padding(.horizontal, PCSpacing.xxl)
                .padding(.bottom, 32)
                .background(
                    GeometryReader { proxy in
                        Color.clear.preference(key: NewSessionSheetHeightKey.self, value: proxy.size.height)
                    }
                )
            }
        }
        if activePicker != nil {
            pickerOverlay
        }
        }
        .background(Color.pcSurface)
        .onPreferenceChange(NewSessionSheetHeightKey.self) { onHeightChange($0) }
        .onAppear {
            workdir = AgentDefaultsStore.getCwd(daemonId: daemon.daemonId, agentType: agent) ?? "~/"
            models = wsService.availableModels[daemon.daemonId] ?? []
            wsService.requestModels(daemonId: daemon.daemonId)
            startListening()
        }
        .onDisappear {
            stopListening()
            timeoutTask?.cancel()
        }
        .animation(.easeInOut(duration: 0.2), value: activePicker)
    }

    // MARK: - Advanced options (Scheme A/C/D)

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.easeInOut(duration: 0.2)) { showAdvanced.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.pcFgTertiary)
                        .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                    Text("高级选项")
                        .font(PCFont.body(12, weight: .semibold))
                        .foregroundStyle(Color.pcFgSecondary)
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            if showAdvanced {
                VStack(spacing: 12) {
                    toggleRow(isOn: $autoCreateDir,
                              title: "目录不存在时自动创建",
                              hint: "工作目录不存在时自动创建，避免因路径缺失而创建失败")
                    toggleRow(isOn: $worktree,
                              title: "Git Worktree 隔离",
                              hint: "在独立的 git 工作区中运行，避免多会话修改同一文件（需 git 仓库）")
                }
                .padding(12)
                .background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
            }
        }
    }

    private var forceCreateSection: some View {
        toggleRow(isOn: $force,
                  title: "我已知晓风险，强制创建",
                  hint: "强制在该目录创建会话，即使已有其他活跃会话。多个会话并发编辑同一文件将由文件锁协调，但建议谨慎操作")
            .padding(12)
            .background(Color.pcWarning.opacity(0.08))
            .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcWarning.opacity(0.3), lineWidth: 1))
            .cornerRadius(PCRadius.md)
    }

    private func toggleRow(isOn: Binding<Bool>, title: String, hint: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Toggle("", isOn: isOn).labelsHidden()
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(PCFont.body(13, weight: .medium)).foregroundStyle(Color.pcFg)
                Text(hint).font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
            }
        }
    }

    // MARK: - Fields

    private var agentPills: some View {
        HStack(spacing: PCSpacing.sm) {
            ForEach(["claude-code", "codex"], id: \.self) { a in
                Button { agent = a } label: {
                    Text(a == "claude-code" ? "Claude Code" : "Codex")
                    .font(PCFont.body(15, weight: .medium))
                    .foregroundStyle(agent == a ? Color.pcBackground : Color.pcFgSecondary)
                    .padding(.horizontal, 20).padding(.vertical, 10)
                    .background(agent == a ? Color.pcAccent : Color.pcHoverInput)
                    .cornerRadius(PCRadius.full)
                }
            }
        }
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("模型", icon: "shippingbox")
            Button { activePicker = .model } label: {
                HStack {
                    Text(currentModelLabel).foregroundStyle(Color.pcFg)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Color.pcFgTertiary)
                }
                .font(PCFont.body(14))
                .padding(12).background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
            }
            .buttonStyle(.plain)
        }
    }

    private var currentModelLabel: String {
        if model.isEmpty { return "跟随主机默认" }
        return models.first { $0.alias == model }?.name ?? model
    }

    private var cwdField: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("工作目录", icon: "folder")
            TextField("~/（默认 home 目录）", text: $workdir)
                .font(PCFont.mono(14)).foregroundStyle(Color.pcFg).padding(12)
                .background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
        }
    }

    private var permissionPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("权限模式", icon: "shield")
            Button { activePicker = .permission } label: {
                HStack {
                    Text(currentPermission.title).foregroundStyle(Color.pcFg)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Color.pcFgTertiary)
                }
                .font(PCFont.body(14))
                .padding(12).background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
            }
            .buttonStyle(.plain)
        }
    }

    private var currentPermission: PermissionMode {
        PermissionMode(rawValue: permission) ?? .acceptEdits
    }

    private var promptField: some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel("初始提示", icon: "text.bubble")
            TextField("描述你想要 AI 完成的任务...", text: $prompt, axis: .vertical)
                .font(PCFont.body(15)).foregroundStyle(Color.pcFg).lineLimit(3...8).padding(12)
                .background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
        }
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.pcError)
            Text(text).font(PCFont.body(13)).foregroundStyle(Color.pcError)
            Spacer()
            Button { errorText = nil } label: {
                Image(systemName: "xmark").font(.system(size: 12)).foregroundStyle(Color.pcFgTertiary)
            }
        }
        .padding(12).background(Color.pcError.opacity(0.1))
        .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcError.opacity(0.35), lineWidth: 1))
        .cornerRadius(PCRadius.md)
    }

    private func fieldLabel(_ text: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 14)).foregroundStyle(Color.pcFgSecondary)
            Text(text).font(PCFont.body(13)).foregroundStyle(Color.pcFgSecondary)
        }
    }

    // MARK: - Bottom picker sheets (model / permission)

    private func sheetHeader(_ title: String) -> some View {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 3).fill(Color.pcFgTertiary).frame(width: 36, height: 5)
                .padding(.top, 12).padding(.bottom, 16)
            Text(title).font(PCFont.display(17, weight: .semibold)).foregroundStyle(Color.pcFg)
                .padding(.bottom, 8)
        }
    }

    private func optionRow(title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button { action() } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.pcAccent : Color.pcFgTertiary)
                Text(title).font(PCFont.body(15, weight: .medium)).foregroundStyle(Color.pcFg)
                Spacer()
            }
            .padding(.horizontal, PCSpacing.lg).padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }

    private var pickerOverlay: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.45).ignoresSafeArea()
                .onTapGesture { activePicker = nil }
            Group {
                switch activePicker {
                case .model: modelPickerSheet
                case .permission: permissionPickerSheet
                case .none: EmptyView()
                }
            }
            .frame(maxHeight: 380)
            .transition(.move(edge: .bottom))
        }
    }

    private var modelPickerSheet: some View {
        VStack(spacing: 0) {
            sheetHeader("选择模型")
            ScrollView {
                VStack(spacing: 0) {
                    optionRow(title: "跟随主机默认", selected: model.isEmpty) {
                        model = ""; activePicker = nil
                    }
                    if models.isEmpty {
                        Text("加载中…").font(PCFont.body(13)).foregroundStyle(Color.pcFgTertiary)
                            .frame(maxWidth: .infinity).padding(.vertical, 20)
                    }
                    ForEach(models) { m in
                        optionRow(title: m.name, selected: model == m.alias) {
                            model = m.alias; activePicker = nil
                        }
                    }
                }
            }
        }
        .background(Color.pcSurface)
    }

    private var permissionPickerSheet: some View {
        VStack(spacing: 0) {
            sheetHeader("权限模式")
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(PermissionMode.allCases) { p in
                        Button {
                            permission = p.rawValue; activePicker = nil
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: permission == p.rawValue ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(permission == p.rawValue ? Color.pcAccent : Color.pcFgTertiary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.title).font(PCFont.body(15, weight: .medium)).foregroundStyle(Color.pcFg)
                                    Text(p.desc).font(PCFont.body(12)).foregroundStyle(Color.pcFgTertiary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, PCSpacing.lg).padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .background(Color.pcSurface)
    }

    // MARK: - Create lifecycle

    private func start() {
        guard canStart, !isCreating else { return }
        phase = .submitting
        errorText = nil
        cwdInUse = false
        done = false
        AgentDefaultsStore.setCwd(daemonId: daemon.daemonId, agentType: agent, cwd: workdir)

        var msg: [String: Any] = [
            "type": "session_create",
            "daemon_id": daemon.daemonId,
            "agent": agent,
            "permission_mode": permission,
        ]
        if !workdir.isEmpty { msg["cwd"] = workdir }
        if !prompt.isEmpty { msg["prompt"] = prompt }
        if !model.isEmpty { msg["model"] = model }
        msg["worktree"] = worktree
        msg["auto_create_dir"] = autoCreateDir
        msg["force"] = force
        wsService.send(msg)

        timeoutTask = Task {
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, !done else { return }
            done = true
            phase = .idle
            wsService.send(["type": "abort_create", "daemon_id": daemon.daemonId])
            errorText = "主机连接超时：daemon 未在 15 秒内完成会话初始化"
        }
    }

    private func startListening() {
        eventListenerId = wsService.addEventListener { dict in
            Task { @MainActor in self.handleEvent(dict) }
        }
    }

    private func stopListening() {
        if let id = eventListenerId { wsService.removeEventListener(id); eventListenerId = nil }
    }

    private func handleEvent(_ dict: [String: Any]) {
        guard let event = WebSocketEvent(dict: dict) else { return }
        switch event.type {
        case .sessionCreated, .sessionIdChanged:
            guard let sid = event.sessionId, !sid.isEmpty, !done else { return }
            if sid.hasPrefix("pending") {
                if phase == .submitting { phase = .connecting }
            } else {
                done = true
                timeoutTask?.cancel()
                phase = .idle
                onCreated(sid)
                dismiss()
            }
        case .sessionCreateFailed:
            guard !done else { return }
            done = true
            timeoutTask?.cancel()
            phase = .idle
            errorText = failedMessage(event.reason, errorDetail: event.error)
        case .modelList:
            // model_list 是对当前 daemon 的 list_models 响应；直接用 payload（对齐 web 的
            // `models.value = msg.models`），不依赖 daemon_id 字段——relay 原样转发 daemon 的
            // model_list，未必携带 daemon_id，之前因此解析失败导致列表为空。
            if let modelDicts = event.models {
                models = modelDicts.compactMap { ModelOption(dict: $0) }
            }
        default:
            break
        }
    }

    private func failedMessage(_ reason: String?, errorDetail: String? = nil) -> String {
        switch reason {
        case "no_cli":
            let agentName = agent == "codex" ? "Codex" : "Claude Code"
            return "主机未安装 \(agentName) CLI，请在主机上安装后重试"
        case "bad_cwd":
            let base = "工作目录不可用：\(workdir)"
            if let detail = errorDetail, !detail.isEmpty {
                return "\(base)\n\(detail)"
            }
            return "\(base)，请检查路径与权限"
        case "cwd_in_use":
            // 进入强制创建确认状态
            cwdInUse = true
            if let detail = errorDetail, !detail.isEmpty {
                return detail
            }
            return "工作目录已有活跃会话，多个会话同时操作同一目录可能产生冲突。如需继续，请开启「强制创建」"
        case "start_fail":
            if let detail = errorDetail, !detail.isEmpty {
                return "Agent 进程启动失败：\(detail)"
            }
            return "Agent 进程启动失败"
        case "daemon_offline": return "主机离线或无可用 daemon，请确认主机在线后重试"
        default:
            if let detail = errorDetail, !detail.isEmpty {
                return "创建会话失败：\(detail)"
            }
            return "创建会话失败，请重试"
        }
    }
}

// MARK: - Permission mode

enum PermissionMode: String, CaseIterable, Identifiable {
    case bypassPermissions
    case `default`
    case acceptEdits
    case plan

    var id: String { rawValue }
    var title: String {
        switch self {
        case .bypassPermissions: return "跳过权限"
        case .default: return "默认"
        case .acceptEdits: return "自动编辑"
        case .plan: return "仅规划"
        }
    }
    var desc: String {
        switch self {
        case .bypassPermissions: return "自动执行所有工具"
        case .default: return "每个工具需确认"
        case .acceptEdits: return "自动执行编辑类工具"
        case .plan: return "只规划不执行"
        }
    }
}
