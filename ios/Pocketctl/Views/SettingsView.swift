import SwiftUI

struct SettingsView: View {
    @Binding var isLoggedIn: Bool
    @Environment(\.dismiss) private var dismiss

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
                                        label: "手机号", value: "未绑定", valueColor: .pcFgTertiary)
                            settingsRow(icon: "message.fill", iconBg: Color.green.opacity(0.15), iconFg: .green,
                                        label: "微信", value: "未绑定", valueColor: .pcFgTertiary)
                            settingsRow(icon: "apple.logo", iconBg: .white.opacity(0.1), iconFg: .white,
                                        label: "Apple ID", value: "未绑定", valueColor: .pcFgTertiary)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // My Hosts section
                        sectionHeader("我的主机")
                        settingsGroup {
                            settingsRow(icon: "desktopcomputer", iconBg: .pcAccentMuted, iconFg: .pcAccent,
                                        label: "主机管理", value: nil)
                            settingsRow(icon: "plus.circle", iconBg: .pcSuccessBg, iconFg: .pcSuccess,
                                        label: "注册新主机", value: nil, labelColor: .pcAccent)
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
                            settingsRow(icon: "questionmark.circle", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                        label: "帮助与反馈", value: nil)
                            settingsRow(icon: "info.circle", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                        label: "关于 pocketctl", value: nil)
                            settingsRow(icon: "doc.text", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                        label: "隐私政策", value: nil)
                            settingsRow(icon: "doc.plaintext", iconBg: .pcHoverInput, iconFg: .pcFgSecondary,
                                        label: "用户协议", value: nil)
                        }
                        .padding(.horizontal, PCSpacing.lg)
                        .padding(.bottom, 24)

                        // Logout
                        settingsGroup {
                            Button {
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
        }
    }

    // MARK: - Profile section

    private var profileSection: some View {
        VStack(spacing: 12) {
            Text("M")
                .font(PCFont.display(28, weight: .semibold))
                .foregroundStyle(Color.pcFgSecondary)
                .frame(width: 72, height: 72)
                .background(Color.pcSurface)
                .clipShape(Circle())
                .overlay(Circle().stroke(Color.pcBorder, lineWidth: 2))

            Text("未登录")
                .font(PCFont.body(17, weight: .medium))
                .foregroundStyle(Color.pcFg)

            Button {} label: {
                Text("编辑资料")
                    .font(PCFont.body(14))
                    .foregroundStyle(Color.pcAccent)
            }
        }
        .padding(.top, 20)
        .padding(.bottom, 24)
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
}
