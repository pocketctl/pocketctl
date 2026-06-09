import SwiftUI

struct SettingsView: View {
    @Binding var isLoggedIn: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel = SettingsViewModel()

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
                            settingsRow(icon: "phone.fill", iconBg: .pcAccentMuted, iconFg: .pcAccent,
                                        label: "手机号",
                                        value: viewModel.displayPhone,
                                        valueColor: viewModel.isPhoneBound ? .pcFgSecondary : .pcFgTertiary)
                            disabledRow(icon: "message.fill", iconBg: Color.green.opacity(0.15), iconFg: .green,
                                        label: "微信", badge: "即将开通")
                            disabledRow(icon: "apple.logo", iconBg: .white.opacity(0.1), iconFg: .white,
                                        label: "Apple ID", badge: "即将开通")
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Server section
                        sectionHeader("服务器")
                        settingsGroup {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 8) {
                                    TextField("http://localhost:8080", text: $viewModel.relayURLText)
                                        .font(PCFont.mono(14))
                                        .foregroundStyle(Color.pcFg)
                                        .autocorrectionDisabled()
                                        .textInputAutocapitalization(.never)
                                        .textFieldStyle(.plain)

                                    Button { Task { await viewModel.testConnection() } } label: {
                                        if viewModel.isTestingConnection {
                                            ProgressView()
                                                .frame(width: 20, height: 20)
                                        } else {
                                            Text("测试")
                                                .font(PCFont.body(14))
                                                .foregroundStyle(Color.pcAccent)
                                        }
                                    }
                                    .disabled(viewModel.isTestingConnection)
                                }

                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(connectionStatusColor)
                                        .frame(width: 8, height: 8)
                                    Text(connectionStatusText)
                                        .font(PCFont.body(12))
                                        .foregroundStyle(Color.pcFgTertiary)
                                }

                                if let msg = viewModel.relayURLValidationMessage {
                                    Text(msg)
                                        .font(PCFont.body(12))
                                        .foregroundStyle(Color.pcError)
                                }
                            }
                            .padding(PCSpacing.lg)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // My Hosts section
                        sectionHeader("我的主机")
                        settingsGroup {
                            Button { dismiss() } label: {
                                settingsRow(icon: "desktopcomputer", iconBg: .pcAccentMuted, iconFg: .pcAccent,
                                            label: "主机管理", value: nil)
                            }
                            .buttonStyle(.plain)

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
                        .padding(.bottom, 12)

                        // Upgrade card
                        settingsGroup {
                            HStack(spacing: 12) {
                                Image(systemName: "star.fill")
                                    .font(.system(size: 16))
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
                            .padding(PCSpacing.lg)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Other section
                        sectionHeader("其他")
                        settingsGroup {
                            Button { viewModel.showHelp = true } label: {
                                settingsRow(icon: "questionmark.circle", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                            label: "帮助与反馈", value: nil)
                            }
                            .buttonStyle(.plain)

                            Button { viewModel.showAbout = true } label: {
                                settingsRow(icon: "info.circle", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                            label: "关于 pocketctl", value: viewModel.appVersion)
                            }
                            .buttonStyle(.plain)

                            Button { viewModel.showPrivacyPolicy = true } label: {
                                settingsRow(icon: "doc.text", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                            label: "隐私政策", value: nil)
                            }
                            .buttonStyle(.plain)

                            Button { viewModel.showUserAgreement = true } label: {
                                settingsRow(icon: "doc.plaintext", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                            label: "用户协议", value: nil)
                            }
                            .buttonStyle(.plain)
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
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(Color.pcAccent)
                    }
                }
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
                        codeLine("curl -fsSL https://pocketctl.com/install.sh | bash")
                        codeLine("pocketctl login")
                        codeLine("pocketctl daemon start")
                    }
                    .padding(PCSpacing.md)
                    .background(Color.pcCodeBg)
                    .cornerRadius(PCRadius.sm)

                    Button {
                        UIPasteboard.general.string = "curl -fsSL https://pocketctl.com/install.sh | bash\npocketctl login\npocketctl daemon start"
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
                            codeLine("curl -fsSL https://pocketctl.com/install.sh | bash")
                            codeLine("")
                            codeLine("# 2. 登录（使用 App 注册的手机号）")
                            codeLine("pocketctl login")
                            codeLine("")
                            codeLine("# 3. 启动守护进程")
                            codeLine("pocketctl daemon start")
                            codeLine("")
                            codeLine("# 4. 查看状态")
                            codeLine("pocketctl daemon status")
                        }
                        .padding(PCSpacing.md)
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)

                        Button {
                            UIPasteboard.general.string = "curl -fsSL https://pocketctl.com/install.sh | bash\npocketctl login\npocketctl daemon start"
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
                        Text("更新日期：2025年1月1日")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)

                        Group {
                            Text("一、信息收集").font(PCFont.body(16, weight: .semibold))
                            Text("我们收集以下信息用于提供服务：手机号码（用于登录验证）、设备信息（用于推送通知）、主机连接数据（用于远程管理）。").font(PCFont.body(15))

                            Text("二、信息使用").font(PCFont.body(16, weight: .semibold))
                            Text("收集的信息仅用于：账户认证、推送通知、服务改进。我们不会将您的个人信息出售或分享给第三方。").font(PCFont.body(15))

                            Text("三、数据安全").font(PCFont.body(16, weight: .semibold))
                            Text("我们采用行业标准的加密技术保护您的数据。所有通信均通过加密通道进行，敏感信息使用安全存储。").font(PCFont.body(15))

                            Text("四、用户权利").font(PCFont.body(16, weight: .semibold))
                            Text("您有权随时查看、修改或删除您的个人信息。如需行使上述权利，请通过应用内反馈功能联系我们。").font(PCFont.body(15))

                            Text("五、Cookie 政策").font(PCFont.body(16, weight: .semibold))
                            Text("本应用不使用 Cookie 进行用户追踪。").font(PCFont.body(15))
                        }
                        .foregroundStyle(Color.pcFg)
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

    private var userAgreementSheet: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("用户协议")
                            .font(PCFont.display(20, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                        Text("更新日期：2025年1月1日")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)

                        Group {
                            Text("一、服务说明").font(PCFont.body(16, weight: .semibold))
                            Text("pocketctl 是一款远程 AI 编程助手管理工具。通过本服务，您可以远程监控和管理运行在开发机上的 AI 编程会话。").font(PCFont.body(15))

                            Text("二、用户责任").font(PCFont.body(16, weight: .semibold))
                            Text("您应当妥善保管账户信息，对账户下的所有活动负责。不得利用本服务从事违法活动或侵犯他人权益。").font(PCFont.body(15))

                            Text("三、服务变更").font(PCFont.body(16, weight: .semibold))
                            Text("我们保留随时修改或中断服务的权利。重大变更将提前通知用户。").font(PCFont.body(15))

                            Text("四、免责声明").font(PCFont.body(16, weight: .semibold))
                            Text("本服务按「现状」提供，不做任何明示或暗示的保证。对于因使用本服务造成的任何直接或间接损失，我们不承担责任。").font(PCFont.body(15))

                            Text("五、适用法律").font(PCFont.body(16, weight: .semibold))
                            Text("本协议受中华人民共和国法律管辖。如有争议，双方应友好协商解决。").font(PCFont.body(15))
                        }
                        .foregroundStyle(Color.pcFg)
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
