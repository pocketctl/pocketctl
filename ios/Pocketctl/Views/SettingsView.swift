import SwiftUI

struct SettingsView: View {
    @Binding var isLoggedIn: Bool
    var daemons: [Daemon] = []
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = SettingsViewModel()
    @State private var showScan = false
    @State private var showGlobalUsage = false
    @State private var showUpgradeAlert = false
    private let apiClient = APIClient()

    var body: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        // Profile section
                        profileSection
                            .padding(.bottom, 24)

                        // Account section
                        sectionHeader("账户")
                        settingsGroup {
                            settingsRow(icon: "envelope.fill", iconBg: .pcAccentMuted, iconFg: .pcAccent,
                                        label: "邮箱",
                                        value: viewModel.displayEmail,
                                        valueColor: viewModel.isEmailBound ? .pcFgSecondary : .pcFgTertiary)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Relay 环境切换
                        sectionHeader("服务器")
                        settingsGroup {
                            VStack(spacing: 0) {
                                HStack(spacing: 12) {
                                    Image(systemName: "antenna.radiowaves.left.and.right")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.pcAccent)
                                        .frame(width: 28, height: 28)
                                        .background(Color.pcAccentMuted)
                                        .cornerRadius(PCRadius.sm)

                                    Text("环境")
                                        .font(PCFont.body(15))
                                        .foregroundStyle(Color.pcFg)

                                    Spacer()

                                    Text(viewModel.currentEnvironment.displayName)
                                        .font(PCFont.body(14, weight: .medium))
                                        .foregroundStyle(Color.pcAccent)

                                    Toggle("", isOn: Binding(
                                        get: { viewModel.currentEnvironment == .staging },
                                        set: { production in
                                            let newEnv: RelayEnvironment = production ? .staging : .production
                                            withAnimation {
                                                viewModel.switchEnvironment(to: newEnv)
                                            }
                                        }
                                    ))
                                    .labelsHidden()
                                    .tint(Color.pcPrimaryBtn)
                                }
                                .padding(.horizontal, PCSpacing.lg)
                                .frame(minHeight: 44)

                                // 显示当前环境 URL
                                HStack(spacing: 12) {
                                    Color.clear
                                        .frame(width: 28, height: 28)

                                    Text(viewModel.currentEnvironment.relayURLText)
                                        .font(PCFont.mono(11))
                                        .foregroundStyle(Color.pcFgTertiary)
                                        .textSelection(.enabled)

                                    Spacer()

                                    Circle()
                                        .fill(connectionStatusColor)
                                        .frame(width: 6, height: 6)
                                }
                                .padding(.horizontal, PCSpacing.lg)
                                .padding(.bottom, PCSpacing.sm)
                            }
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // My Hosts section
                        sectionHeader("我的主机")
                        settingsGroup {
                            ForEach(daemons) { d in
                                Button { dismiss() } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "desktopcomputer")
                                            .font(.system(size: 14))
                                            .foregroundStyle(Color.pcAccent)
                                            .frame(width: 28, height: 28)
                                            .background(Color.pcAccentMuted)
                                            .cornerRadius(PCRadius.sm)
                                        Text(d.displayName)
                                            .font(PCFont.body(15))
                                            .foregroundStyle(Color.pcFg)
                                        Spacer()
                                        Text(d.online ? "在线" : "离线")
                                            .font(PCFont.body(11, weight: .medium))
                                            .foregroundStyle(d.online ? Color.pcSuccess : Color.pcFgTertiary)
                                            .padding(.horizontal, 8).padding(.vertical, 2)
                                            .background(d.online ? Color.pcSuccessBg : Color.pcHoverInput)
                                            .cornerRadius(PCRadius.full)
                                    }
                                    .padding(.horizontal, PCSpacing.lg)
                                    .frame(minHeight: 44)
                                    .overlay(Rectangle().fill(Color.pcBorder).frame(height: 0.5).padding(.leading, 56), alignment: .bottom)
                                }
                                .buttonStyle(.plain)
                            }
                            if daemons.isEmpty {
                                Button { dismiss() } label: {
                                    settingsRow(icon: "desktopcomputer", iconBg: .pcAccentMuted, iconFg: .pcAccent,
                                                label: "主机管理", value: nil)
                                }
                                .buttonStyle(.plain)
                            }

                            Button { viewModel.showRegisterHost = true } label: {
                                settingsRow(icon: "plus.circle", iconBg: .pcSuccessBg, iconFg: .pcSuccess,
                                            label: "注册新主机", value: nil, labelColor: .pcAccent)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Notifications section
                        sectionHeader("通知")
                        settingsGroup {
                            HStack(spacing: 12) {
                                Image(systemName: "bell.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.pcAccent)
                                    .frame(width: 28, height: 28)
                                    .background(Color.pcAccentMuted)
                                    .cornerRadius(PCRadius.sm)

                                Text("推送通知")
                                    .font(PCFont.body(15))
                                    .foregroundStyle(Color.pcFg)

                                Spacer()

                                Toggle("", isOn: Binding(
                                    get: { viewModel.notificationsEnabled },
                                    set: { viewModel.toggleNotifications($0) }
                                ))
                                .labelsHidden()
                                .tint(Color.pcPrimaryBtn)
                            }
                            .padding(.horizontal, PCSpacing.lg)
                            .frame(minHeight: 44)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Subscription section
                        sectionHeader("订阅")
                        settingsGroup {
                            HStack {
                                Text("当前方案")
                                    .font(PCFont.body(15))
                                    .foregroundStyle(Color.pcFg)
                                Spacer()
                                Text("免费版")
                                    .font(PCFont.body(12, weight: .semibold))
                                    .foregroundStyle(Color.pcFgTertiary)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 3)
                                    .background(Color.pcHoverInput)
                                    .cornerRadius(PCRadius.full)
                            }
                            .padding(.horizontal, PCSpacing.lg)
                            .padding(.vertical, PCSpacing.md)

                            Text("免费版：1 台主机，基础监控")
                                .font(PCFont.body(13))
                                .foregroundStyle(Color.pcFgTertiary)
                                .padding(.horizontal, PCSpacing.lg)
                                .padding(.bottom, PCSpacing.md)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Upgrade to Pro (placeholder — no payment backend yet)
                        settingsGroup {
                            Button { showUpgradeAlert = true } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "star.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.pcAccent)
                                        .frame(width: 28, height: 28)
                                        .background(Color.pcAccentMuted)
                                        .cornerRadius(PCRadius.sm)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("升级专业版 ¥48/月")
                                            .font(PCFont.body(16, weight: .medium))
                                            .foregroundStyle(Color.pcAccent)
                                        Text("无限主机 · 推送通知 · 实时消息")
                                            .font(PCFont.body(12))
                                            .foregroundStyle(Color.pcFgTertiary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.pcAccent)
                                }
                                .padding(.horizontal, PCSpacing.lg)
                                .frame(minHeight: 44)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // 关于
                        sectionHeader("其他")
                        settingsGroup {
                            aboutRow
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Logout
                        settingsGroup {
                            Button {
                                viewModel.logout()
                                isLoggedIn = false
                                dismiss()
                            } label: {
                                Text("退出登录")
                                    .font(PCFont.body(15, weight: .medium))
                                    .foregroundStyle(Color.pcError)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, PCSpacing.md)
                            }
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 32)
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $showGlobalUsage) {
                TokenUsageView(daemonId: nil, apiClient: apiClient)
            }
            .alert("专业版即将上线", isPresented: $showUpgradeAlert) {
                Button("好的", role: .cancel) {}
            } message: {
                Text("专业版订阅功能正在开发中，敬请期待。")
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(Color.pcAccent)
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showScan = true } label: {
                        ScanIcon()
                    }
                    .accessibilityLabel("扫一扫，授权网页端登录")
                }
            }
            .sheet(isPresented: $showScan) {
                ScanLoginView()
            }
            .sheet(isPresented: $viewModel.showEditProfile) { editProfileSheet }
            .sheet(isPresented: $viewModel.showRegisterHost) { registerHostSheet }
            .sheet(isPresented: $viewModel.showPrivacyPolicy) { privacyPolicySheet }
            .sheet(isPresented: $viewModel.showUserAgreement) { userAgreementSheet }
            .sheet(isPresented: $viewModel.showAbout) { aboutSheet }
            .sheet(isPresented: $viewModel.showHelp) { helpSheet }
            .onDisappear {
                viewModel.validateAndSaveRelayURL()
            }
        }
    }

    // MARK: - Connection status helpers

    private var connectionStatusColor: Color {
        switch viewModel.connectionStatus {
        case .connected: return .pcSuccess
        case .disconnected: return .pcError
        case .testing: return .pcWarning
        case .unknown: return .pcFgTertiary
        }
    }

    private var connectionStatusText: String {
        switch viewModel.connectionStatus {
        case .connected: return "已连接"
        case .disconnected: return "未连接"
        case .testing: return "测试中..."
        case .unknown: return "未测试"
        }
    }

    // MARK: - Profile section

    private var profileSection: some View {
        VStack(spacing: 12) {
            Text(viewModel.avatarInitial)
                .font(PCFont.display(28, weight: .semibold))
                .foregroundStyle(Color.pcFgSecondary)
                .frame(width: 72, height: 72)
                .background(Color.pcSurface)
                .clipShape(Circle())
                .overlay(Circle().stroke(Color.pcBorder, lineWidth: 2))

            Text(viewModel.effectiveDisplayName)
                .font(PCFont.body(17, weight: .medium))
                .foregroundStyle(Color.pcFg)

            Button { viewModel.prepareEditProfile() } label: {
                Text("编辑资料")
                    .font(PCFont.body(14))
                    .foregroundStyle(Color.pcAccent)
            }
        }
        .padding(.top, 20)
        .padding(.bottom, 24)
    }

    // MARK: - Disabled row helper

    private func disabledRow(icon: String, iconBg: Color, iconFg: Color,
                              label: String, badge: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(iconFg)
                .frame(width: 28, height: 28)
                .background(iconBg)
                .cornerRadius(PCRadius.sm)

            Text(label)
                .font(PCFont.body(15))
                .foregroundStyle(Color.pcFg)

            Spacer()

            Text(badge)
                .font(PCFont.body(12))
                .foregroundStyle(Color.pcFgTertiary)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Color.pcHoverInput)
                .cornerRadius(PCRadius.full)
        }
        .padding(.horizontal, PCSpacing.lg)
        .frame(minHeight: 44)
        .opacity(0.6)
    }

    // MARK: - Section helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(PCFont.body(13, weight: .medium))
            .foregroundStyle(Color.pcFgSecondary)
            .textCase(.uppercase)
            .kerning(0.3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, PCSpacing.xxl)
            .padding(.bottom, 8)
    }

    private func settingsGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content()
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
    }

    private func settingsRow(
        icon: String,
        iconBg: Color,
        iconFg: Color,
        label: String,
        value: String?,
        valueColor: Color = .pcFgSecondary,
        labelColor: Color = .pcFg
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(iconFg)
                .frame(width: 28, height: 28)
                .background(iconBg)
                .cornerRadius(PCRadius.sm)

            Text(label)
                .font(PCFont.body(15))
                .foregroundStyle(labelColor)

            Spacer()

            if let value {
                Text(value)
                    .font(PCFont.body(15))
                    .foregroundStyle(valueColor)
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 14))
                .foregroundStyle(Color.pcFgTertiary)
        }
        .padding(.horizontal, PCSpacing.lg)
        .frame(minHeight: 44)
        .overlay(
            Rectangle()
                .fill(Color.pcBorder)
                .frame(height: 0.5)
                .padding(.leading, 56),
            alignment: .bottom
        )
    }

    // MARK: - Sheets

    private var editProfileSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                VStack(spacing: 16) {
                    Text(viewModel.avatarInitial)
                        .font(PCFont.display(28, weight: .semibold))
                        .foregroundStyle(Color.pcFgSecondary)
                        .frame(width: 72, height: 72)
                        .background(Color.pcSurface)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.pcBorder, lineWidth: 2))

                    VStack(alignment: .leading, spacing: 6) {
                        Text("昵称")
                            .font(PCFont.body(13, weight: .medium))
                            .foregroundStyle(Color.pcFgSecondary)
                        TextField("请输入昵称", text: $viewModel.editDisplayName)
                            .font(PCFont.body(17))
                            .foregroundStyle(Color.pcFg)
                            .padding(PCSpacing.md)
                            .background(Color.pcSurface)
                            .cornerRadius(PCRadius.md)
                            .overlay(
                                RoundedRectangle(cornerRadius: PCRadius.md)
                                    .stroke(Color.pcBorder, lineWidth: 1)
                            )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("手机号")
                            .font(PCFont.body(13, weight: .medium))
                            .foregroundStyle(Color.pcFgSecondary)
                        Text(viewModel.displayPhone)
                            .font(PCFont.body(17))
                            .foregroundStyle(Color.pcFgTertiary)
                            .padding(PCSpacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.pcSurface)
                            .cornerRadius(PCRadius.md)
                            .overlay(
                                RoundedRectangle(cornerRadius: PCRadius.md)
                                    .stroke(Color.pcBorder, lineWidth: 1)
                            )
                    }

                    Spacer()
                }
                .padding(PCSpacing.lg)
            }
            .navigationTitle("编辑资料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("取消") { viewModel.showEditProfile = false }
                        .foregroundStyle(Color.pcAccent)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("保存") { viewModel.saveDisplayName() }
                        .foregroundStyle(Color.pcAccent)
                        .font(PCFont.body(16, weight: .semibold))
                }
            }
        }
    }

    private var registerHostSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                VStack(spacing: 16) {
                    Text("在你的开发机上运行以下命令")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFgSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .leading, spacing: 4) {
                        let env = RelayEnvironmentManager.shared.current
                        codeLine("curl -fsSL \(env.installURL) -o /tmp/install-daemon.sh")
                        codeLine("sudo POCKETCTL_PROD_RELAY_URL=\(env.wsBaseURL) bash /tmp/install-daemon.sh --prod")
                        codeLine("pocketctl login")
                        codeLine("pocketctl daemon start")
                    }
                    .padding(PCSpacing.md)
                    .background(Color.pcCodeBg)
                    .cornerRadius(PCRadius.sm)

                    Button {
                        let env = RelayEnvironmentManager.shared.current
                        UIPasteboard.general.string = "curl -fsSL \(env.installURL) -o /tmp/install-daemon.sh\nsudo POCKETCTL_PROD_RELAY_URL=\(env.wsBaseURL) bash /tmp/install-daemon.sh --prod\npocketctl login\npocketctl daemon start"
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "doc.on.doc")
                            Text("复制命令")
                        }
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcAccent)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.pcSurface)
                        .cornerRadius(PCRadius.sm)
                        .overlay(RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorder, lineWidth: 1))
                    }

                    Spacer()
                }
                .padding(PCSpacing.lg)
            }
            .navigationTitle("注册新主机")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { viewModel.showRegisterHost = false }
                        .foregroundStyle(Color.pcAccent)
                }
            }
        }
    }

    private func codeLine(_ text: String) -> some View {
        Text(text)
            .font(PCFont.mono(12))
            .foregroundStyle(Color.pcSuccess)
            .textSelection(.enabled)
    }

    private var aboutSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                VStack(spacing: 20) {
                    Spacer().frame(height: 40)
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(Color.pcAccent)
                    Text("pocketctl")
                        .font(PCFont.display(24, weight: .bold))
                        .foregroundStyle(Color.pcAccent)
                    Text(viewModel.appVersion)
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgSecondary)
                    Text("远程掌控你的 AI 编程助手")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFgSecondary)

                    if !viewModel.relayURLText.isEmpty {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(connectionStatusColor)
                                .frame(width: 8, height: 8)
                            Text("服务器: \(viewModel.relayURLText)")
                                .font(PCFont.mono(12))
                                .foregroundStyle(Color.pcFgTertiary)
                        }
                        .padding(.top, 8)
                    }
                    Spacer()
                }
            }
            .navigationTitle("关于")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { viewModel.showAbout = false }
                        .foregroundStyle(Color.pcAccent)
                }
            }
        }
    }

    private var helpSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Daemon installation guide
                        Text("安装 Daemon")
                            .font(PCFont.body(16, weight: .semibold))
                            .foregroundStyle(Color.pcFg)

                        Text("在你的 Mac 或 Linux 开发机上运行以下命令，安装并启动 Daemon 守护进程：")
                            .font(PCFont.body(15))
                            .foregroundStyle(Color.pcFgSecondary)

                        VStack(alignment: .leading, spacing: 4) {
                            codeLine("# 1. 安装 Daemon")
                            let env = viewModel.currentEnvironment
                            codeLine("curl -fsSL \(env.installURL) -o /tmp/install-daemon.sh")
                            codeLine("sudo POCKETCTL_PROD_RELAY_URL=\(env.wsBaseURL) bash /tmp/install-daemon.sh --prod")
                            codeLine("")
                            codeLine("# 登录（使用 App 注册的手机号）")
                            codeLine("pocketctl login")
                            codeLine("")
                            codeLine("# 启动守护进程")
                            codeLine("pocketctl daemon start")
                            codeLine("")
                            codeLine("# 查看状态")
                            codeLine("pocketctl daemon status")
                        }
                        .padding(PCSpacing.md)
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)

                        Button {
                            let env = viewModel.currentEnvironment
                            UIPasteboard.general.string = "curl -fsSL \(env.installURL) -o /tmp/install-daemon.sh\nsudo POCKETCTL_PROD_RELAY_URL=\(env.wsBaseURL) bash /tmp/install-daemon.sh --prod\npocketctl login\npocketctl daemon start"
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc.on.doc")
                                Text("复制命令")
                            }
                            .font(PCFont.body(14))
                            .foregroundStyle(Color.pcAccent)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(Color.pcSurface)
                            .cornerRadius(PCRadius.sm)
                            .overlay(RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorder, lineWidth: 1))
                        }

                        Divider()
                            .background(Color.pcBorder)

                        // Feedback section
                        Text("意见反馈")
                            .font(PCFont.body(16, weight: .semibold))
                            .foregroundStyle(Color.pcFg)

                        Text("遇到问题或有建议？欢迎通过邮件联系我们：")
                            .font(PCFont.body(15))
                            .foregroundStyle(Color.pcFgSecondary)

                        Button {
                            if let url = URL(string: "mailto:james_2001_2001@163.com?subject=pocketctl%20%E5%8F%8D%E9%A6%88") {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "envelope.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.pcAccent)
                                Text("james_2001_2001@163.com")
                                    .font(PCFont.body(15))
                                    .foregroundStyle(Color.pcAccent)
                            }
                            .padding(.vertical, 4)
                        }

                        Spacer()
                    }
                    .padding(PCSpacing.lg)
                }
            }
            .navigationTitle("帮助与反馈")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { viewModel.showHelp = false }
                        .foregroundStyle(Color.pcAccent)
                }
            }
        }
    }

    private var privacyPolicySheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("隐私政策")
                            .font(PCFont.display(20, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                        Text("更新日期：2026年6月10日")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)

                        Group {
                            privacySection("一、信息收集",
                                "pocketctl（以下简称'我们'）在提供服务过程中，可能收集以下信息：\n\n1. 账户信息：手机号码，用于登录验证和账户识别。\n2. 设备信息：设备型号、操作系统版本、设备标识符，用于推送通知和安全认证。\n3. 使用数据：功能使用频率、操作日志，用于服务改进和问题排查。\n4. 主机连接数据：主机名、IP 地址（仅在连接时临时使用），用于远程管理功能。")

                            privacySection("二、信息使用",
                                "我们收集的信息仅用于以下目的：\n\n1. 提供核心服务：账户认证、会话管理、远程控制。\n2. 推送通知：任务完成、错误提醒、主机状态变更。\n3. 服务改进：分析使用模式，优化产品体验。\n4. 安全保障：异常登录检测、欺诈防范。\n\n我们不会将您的个人信息出售给第三方。")

                            privacySection("三、第三方服务",
                                "本应用使用以下第三方服务：\n\n1. 智谱 AI（GLM-4.6）：用于自动生成会话标题，仅传输会话首条消息摘要，不传输完整对话内容。\n2. Apple Push Notification Service（APNs）：用于 iOS 推送通知。\n\n上述第三方服务有独立的隐私政策，我们建议您查阅其相关政策。")

                            privacySection("四、数据存储与安全",
                                "1. 数据存储在位于中国的云服务器上。\n2. 所有网络通信均通过 HTTPS/WSS 加密传输。\n3. 敏感信息（如认证令牌）使用 iOS Keychain 安全存储。\n4. 数据库采用加密存储，定期备份。")

                            privacySection("五、用户权利",
                                "您享有以下权利：\n\n1. 查看权：随时查看您的账户信息和使用数据。\n2. 删除权：请求删除您的账户和所有相关数据。\n3. 导出权：请求导出您的会话历史数据。\n4. 撤回同意权：随时撤回对数据处理的同意。\n\n行使上述权利，请通过应用内「帮助与反馈」联系我们。")

                            privacySection("六、未成年人保护",
                                "本服务不面向 14 岁以下未成年人。如您为未成年人，请在监护人指导下使用本服务。")

                            privacySection("七、政策更新",
                                "我们可能不时更新本隐私政策。重大变更将通过应用内通知或电子邮件告知您。继续使用本服务即表示您同意更新后的政策。")

                            privacySection("八、联系我们",
                                "如您对本隐私政策有任何疑问，请通过以下方式联系我们：\n\n邮箱：james_2001_2001@163.com")
                        }
                    }
                    .padding(PCSpacing.lg)
                }
            }
            .navigationTitle("隐私政策")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { viewModel.showPrivacyPolicy = false }
                        .foregroundStyle(Color.pcAccent)
                }
            }
        }
    }

    // MARK: - About row

    private var aboutRow: some View {
        VStack(spacing: 0) {
            Button { showGlobalUsage = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "chart.bar.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcAccent)
                        .frame(width: 28, height: 28)
                        .background(Color.pcAccentMuted)
                        .cornerRadius(PCRadius.sm)
                    Text("用量分析")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, PCSpacing.lg)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)

            Button {
                viewModel.showAbout = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "info.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcAccent)
                        .frame(width: 28, height: 28)
                        .background(Color.pcAccentMuted)
                        .cornerRadius(PCRadius.sm)

                    Text("关于")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)

                    Spacer()

                    Text(viewModel.appVersion)
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgTertiary)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, PCSpacing.lg)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)

            Button {
                viewModel.showHelp = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "questionmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcAccent)
                        .frame(width: 28, height: 28)
                        .background(Color.pcAccentMuted)
                        .cornerRadius(PCRadius.sm)

                    Text("帮助与反馈")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, PCSpacing.lg)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)

            Button {
                viewModel.showPrivacyPolicy = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcAccent)
                        .frame(width: 28, height: 28)
                        .background(Color.pcAccentMuted)
                        .cornerRadius(PCRadius.sm)

                    Text("隐私政策")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, PCSpacing.lg)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)

            Button {
                viewModel.showUserAgreement = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcAccent)
                        .frame(width: 28, height: 28)
                        .background(Color.pcAccentMuted)
                        .cornerRadius(PCRadius.sm)

                    Text("用户协议")
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, PCSpacing.lg)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
        }
    }

    private func privacySection(_ title: String, _ content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(PCFont.body(16, weight: .semibold))
                .foregroundStyle(Color.pcFg)
            Text(content)
                .font(PCFont.body(15))
                .foregroundStyle(Color.pcFg)
        }
    }

    private var userAgreementSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("用户协议")
                            .font(PCFont.display(20, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                        Text("更新日期：2026年6月10日")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)

                        Group {
                            privacySection("一、服务说明",
                                "pocketctl 是一款远程 AI 编程助手管理工具。通过本服务，您可以：\n\n1. 远程监控运行在开发机上的 AI 编程会话（如 Claude Code、Codex）。\n2. 查看会话状态、消息历史、工具调用详情。\n3. 通过移动设备发送消息和管理会话。\n4. 接收任务完成和错误提醒的推送通知。")

                            privacySection("二、账户注册与安全",
                                "1. 您需要通过手机号码验证注册账户。\n2. 您应妥善保管账户信息，不得将账户转让或借给他人使用。\n3. 您对账户下的所有活动承担责任。\n4. 如发现账户被盗用，请立即联系我们。")

                            privacySection("三、使用规范",
                                "您同意在使用本服务时：\n\n1. 遵守中华人民共和国法律法规。\n2. 不利用本服务从事违法活动或侵犯他人权益。\n3. 不尝试攻击、干扰或破坏服务的正常运行。\n4. 不利用本服务对他人计算机系统进行未授权访问。")

                            privacySection("四、知识产权",
                                "1. pocketctl 软件、界面设计、商标等知识产权归我们所有。\n2. 您通过本服务创建的内容（如会话记录）归您所有。\n3. 您授予我们在提供服务范围内使用您内容的必要许可。")

                            privacySection("五、付费条款",
                                "1. 本服务目前提供免费使用。\n2. 未来可能推出付费订阅计划，届时将另行公告。\n3. 付费服务的具体条款将在订阅页面明确说明。")

                            privacySection("六、服务变更与中断",
                                "1. 我们保留随时修改或中断服务的权利。\n2. 重大变更将提前 30 天通知用户。\n3. 因不可抗力导致的服务中断，我们不承担责任。")

                            privacySection("七、免责声明",
                                "1. 本服务按「现状」提供，不做任何明示或暗示的保证。\n2. 对于因使用本服务造成的任何直接或间接损失，我们的赔偿责任不超过您在过去 12 个月内支付的费用总额。\n3. 您应自行备份重要数据，我们不对数据丢失承担责任。")

                            privacySection("八、协议终止",
                                "1. 您可随时通过应用内「退出登录」并联系客服删除账户来终止本协议。\n2. 我们保留在您违反本协议时终止服务的权利。\n3. 协议终止后，我们将在合理期限内删除您的数据。")

                            privacySection("九、适用法律与争议解决",
                                "1. 本协议受中华人民共和国法律管辖。\n2. 如有争议，双方应友好协商解决。\n3. 协商不成的，任何一方可向我们所在地人民法院提起诉讼。")
                        }
                    }
                    .padding(PCSpacing.lg)
                }
            }
            .navigationTitle("用户协议")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { viewModel.showUserAgreement = false }
                        .foregroundStyle(Color.pcAccent)
                }
            }
        }
    }
}

// MARK: - Scan icon (custom, matches ui-design/screens/settings.html)

private struct ScanIcon: View {
    var body: some View {
        Canvas { context, size in
            let scale = size.width / 24
            context.scaleBy(x: scale, y: scale)
            var path = Path()
            // Three corner brackets
            path.addRoundedRect(in: CGRect(x: 3, y: 3, width: 7, height: 7), cornerSize: CGSize(width: 1, height: 1))
            path.addRoundedRect(in: CGRect(x: 14, y: 3, width: 7, height: 7), cornerSize: CGSize(width: 1, height: 1))
            path.addRoundedRect(in: CGRect(x: 3, y: 14, width: 7, height: 7), cornerSize: CGSize(width: 1, height: 1))
            // Bottom-right QR marks
            path.addRect(CGRect(x: 14, y: 14, width: 3, height: 3))
            path.move(to: CGPoint(x: 20, y: 14)); path.addLine(to: CGPoint(x: 20, y: 17))
            path.move(to: CGPoint(x: 14, y: 20)); path.addLine(to: CGPoint(x: 17, y: 20))
            path.move(to: CGPoint(x: 20, y: 20)); path.addLine(to: CGPoint(x: 20, y: 20.01))
            context.stroke(path, with: .color(Color.pcAccent), lineWidth: 2)
        }
        .frame(width: 22, height: 22)
    }
}
