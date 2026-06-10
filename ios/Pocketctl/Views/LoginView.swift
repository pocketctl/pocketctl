import SwiftUI

struct LoginView: View {
    @Binding var isLoggedIn: Bool

    @State private var phoneText = RelayEnvironmentManager.shared.current == .staging ? "13800138000" : ""
    private let apiClient = APIClient()
    @FocusState private var phoneFocused: Bool
    @FocusState private var focusedCodeIndex: Int?
    @State private var codeDigits: [String] = Array(repeating: "", count: 6)
    @State private var countdown = 0
    @State private var isLoading = false
    @State private var error: String?
    @State private var showPrivacyPolicy = false
    @State private var showUserAgreement = false
    private let countdownTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40).frame(height: 40)

            // Logo
            logoSection
                .padding(.bottom, 32)

            // Error
            if let error {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill")
                    Text(error).font(PCFont.body(14))
                }
                .foregroundStyle(Color.pcError)
                .padding(12).frame(maxWidth: 340)
                .background(Color.pcErrorBg).cornerRadius(PCRadius.sm)
                .padding(.bottom, 16)
            }

            // Form
            VStack(spacing: 0) {
                Text("登录")
                    .font(PCFont.display(28, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.bottom, 20)

                phoneInputField.padding(.bottom, 16)
                codeInputField.padding(.bottom, 16)
                loginButton.padding(.bottom, 16)
                termsView
            }
            .frame(maxWidth: 340)
            .padding(.horizontal, PCSpacing.xxl)

            socialSection.padding(.top, PCSpacing.xl)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.pcBackground)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                phoneFocused = true
            }
        }
        .onChange(of: phoneText) { _, newValue in
            let f = newValue.filter { $0.isNumber }
            if f != newValue { phoneText = f }
            if f.count > 11 { phoneText = String(f.prefix(11)) }
            if phoneText.count == 11, phoneText.first == "1" {
                focusedCodeIndex = 0
            }
        }
        .onReceive(countdownTimer) { _ in
            if countdown > 0 { countdown -= 1 }
        }
        .sheet(isPresented: $showPrivacyPolicy) {
            LoginLegalDocumentView(
                title: "隐私政策",
                date: "2026年6月10日",
                sections: privacyPolicySections
            )
        }
        .sheet(isPresented: $showUserAgreement) {
            LoginLegalDocumentView(
                title: "用户协议",
                date: "2026年6月10日",
                sections: userAgreementSections
            )
        }
    }

    // MARK: - Logo

    private var logoSection: some View {
        VStack(spacing: 0) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 24)).foregroundStyle(Color.pcAccent)
                .padding(.bottom, 6)
            Text("pocketctl")
                .font(PCFont.display(22, weight: .bold)).foregroundStyle(Color.pcAccent)
                .padding(.bottom, 8)
            Text("远程掌控你的 AI 编程助手")
                .font(PCFont.body(15)).foregroundStyle(Color.pcFgSecondary)
        }
    }

    // MARK: - Phone input

    private var phoneInputField: some View {
        HStack(spacing: 0) {
            HStack(spacing: 4) {
                Text("+86")
                    .font(.system(size: 16, weight: .medium)).foregroundStyle(Color.pcFg)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.pcFgTertiary)
            }
            .padding(.horizontal, 12).padding(.vertical, 14)
            .background(Color.pcSurface)
            .overlay(alignment: .trailing) {
                Rectangle().fill(Color.pcBorder).frame(width: 1).allowsHitTesting(false)
            }

            TextField("请输入手机号", text: $phoneText)
                .font(PCFont.body(17)).foregroundStyle(Color.pcFg)
                .keyboardType(.numberPad).textContentType(.telephoneNumber)
                .focused($phoneFocused).accentColor(Color.pcAccent)
                .padding(.horizontal, 12).padding(.vertical, 14)
        }
        .frame(height: 50)
        .background(Color.pcBackground)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(phoneFocused ? Color.pcAccent : Color.pcBorder, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcAccentMuted, lineWidth: 3).blur(radius: 1)
                .allowsHitTesting(false)
                .opacity(phoneFocused ? 1 : 0)
        )
    }

    // MARK: - Code input

    private var codeInputField: some View {
        HStack(spacing: PCSpacing.sm) {
            HStack(spacing: 6) {
                ForEach(0..<6, id: \.self) { idx in
                    TextField("", text: $codeDigits[idx])
                        .font(PCFont.mono(20)).foregroundStyle(Color.pcFg)
                        .keyboardType(.numberPad).multilineTextAlignment(.center)
                        .focused($focusedCodeIndex, equals: idx)
                        .frame(width: 40, height: 48)
                        .background(RoundedRectangle(cornerRadius: PCRadius.sm)
                            .fill(codeDigits[idx].isEmpty ? Color.pcBackground : Color.pcAccentMuted))
                        .cornerRadius(PCRadius.sm)
                        .overlay(
                            RoundedRectangle(cornerRadius: PCRadius.sm)
                                .stroke(focusedCodeIndex == idx || !codeDigits[idx].isEmpty
                                        ? Color.pcAccent : Color.pcBorder, lineWidth: 1)
                                .allowsHitTesting(false)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: PCRadius.sm)
                                .stroke(Color.pcAccentMuted, lineWidth: 2).blur(radius: 0.5)
                                .allowsHitTesting(false)
                                .opacity(focusedCodeIndex == idx ? 1 : 0)
                        )
                        .onChange(of: codeDigits[idx]) { _, new in
                            let f = new.filter { $0.isNumber }
                            if f.count > 1 { codeDigits[idx] = String(f.last!) }
                            else if f.isEmpty, !new.isEmpty { codeDigits[idx] = "" }
                            else { codeDigits[idx] = f }
                            if codeDigits[idx].count == 1, idx < 5 { focusedCodeIndex = idx + 1 }
                            if codeDigits.allSatisfy({ $0.count == 1 }) {
                                Task { await doLogin() }
                            }
                        }
                }
            }
            Spacer()
            Button {
                Task { await doSendCode() }
            } label: {
                Text(countdown > 0 ? "\(countdown)s 后重发" : "获取验证码")
                    .font(PCFont.body(14))
                    .foregroundStyle(canSendCode ? Color.pcAccent : Color.pcFgTertiary)
                    .padding(.horizontal, 4)
            }
            .disabled(!canSendCode)
        }
    }

    // MARK: - Login button

    private var loginButton: some View {
        Button {
            Task { await doLogin() }
        } label: {
            HStack(spacing: 8) {
                if isLoading { ProgressView().tint(.white) }
                Text(isLoading ? "登录中..." : "登录")
                    .font(PCFont.display(17, weight: .semibold))
            }
            .foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 16)
            .background(canLogin ? Color.pcPrimaryBtn : Color.pcPrimaryBtn.opacity(0.5))
            .cornerRadius(PCRadius.md)
            .contentShape(Rectangle())
        }
        .disabled(!canLogin)
    }

    // MARK: - Terms

    private var termsView: some View {
        HStack(spacing: 0) {
            Text("登录即同意").foregroundStyle(Color.pcFgTertiary)
            Button { showUserAgreement = true } label: {
                Text("《用户协议》").foregroundStyle(Color.pcAccent)
            }
            Text("和").foregroundStyle(Color.pcFgTertiary)
            Button { showPrivacyPolicy = true } label: {
                Text("《隐私政策》").foregroundStyle(Color.pcAccent)
            }
        }
        .font(PCFont.body(12)).multilineTextAlignment(.center).frame(maxWidth: .infinity)
    }

    // MARK: - Social

    private var socialSection: some View {
        VStack(spacing: PCSpacing.xl) {
            // Divider with text — matches .divider-with-text in shared.css
            HStack(spacing: PCSpacing.md) {
                Rectangle().fill(Color.pcBorder).frame(height: 1)
                Text("其他登录方式")
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.pcFgSecondary)
                Rectangle().fill(Color.pcBorder).frame(height: 1)
            }
            .padding(.horizontal, PCSpacing.xxl + PCSpacing.lg)

            // Social buttons row — matches .social-row
            HStack(spacing: PCSpacing.xl) {
                // Apple Sign In — matches .social-btn
                Button {} label: {
                    Image(systemName: "apple.logo")
                        .font(.system(size: 28))
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56)
                        .background(Color.pcSurface)
                        .cornerRadius(PCRadius.lg)
                        .overlay(
                            RoundedRectangle(cornerRadius: PCRadius.lg)
                                .stroke(Color.pcBorder, lineWidth: 1)
                                .allowsHitTesting(false)
                        )
                }

                // WeChat — matches .social-btn.disabled
                Image(systemName: "message.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(Color(hex: 0x07C160))
                    .frame(width: 56, height: 56)
                    .background(Color.pcSurface)
                    .cornerRadius(PCRadius.lg)
                    .overlay(
                        RoundedRectangle(cornerRadius: PCRadius.lg)
                            .stroke(Color.pcBorder, lineWidth: 1)
                            .allowsHitTesting(false)
                    )
                    .opacity(0.4)
                    .overlay(alignment: .bottom) {
                        Text("即将开通")
                            .font(PCFont.body(10))
                            .foregroundStyle(Color.pcFgTertiary)
                            .offset(y: 16)
                    }
            }
        }
    }

    // MARK: - Actions

    private var canSendCode: Bool {
        let digits = phoneText.filter { $0.isNumber }
        return digits.count == 11 && digits.first == "1" && countdown == 0
    }

    private var canLogin: Bool {
        codeDigits.allSatisfy({ $0.count == 1 }) && !isLoading
    }

    private func doSendCode() async {
        let phone = phoneText.filter { $0.isNumber }
        do {
            _ = try await apiClient.sendSMS(phone: phone)
            countdown = 60
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func doLogin() async {
        guard canLogin else { return }
        isLoading = true
        error = nil
        let phone = phoneText.filter { $0.isNumber }
        do {
            let resp = try await apiClient.verifySMS(phone: phone, code: codeDigits.joined())
            KeychainStorage.accessToken = resp.access_token
            KeychainStorage.refreshToken = resp.refresh_token
            KeychainStorage.currentUser = resp.user
            isLoggedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Legal Document View (shared for LoginView sheets)

private struct LoginLegalDocumentView: View {
    let title: String
    let date: String
    let sections: [(String, String)]

    var body: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(title)
                            .font(PCFont.display(20, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                        Text("更新日期：\(date)")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)

                        ForEach(sections, id: \.0) { section in
                            Text(section.0)
                                .font(PCFont.body(16, weight: .semibold))
                                .foregroundStyle(Color.pcFg)
                            Text(section.1)
                                .font(PCFont.body(15))
                                .foregroundStyle(Color.pcFg)
                        }
                    }
                    .padding(PCSpacing.lg)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    // Environment dismiss not available in struct, use presentationMode
                    Text("")
                }
            }
        }
    }
}

// MARK: - Legal Content

private let privacyPolicySections: [(String, String)] = [
    ("一、信息收集",
     "pocketctl（以下简称'我们'）在提供服务过程中，可能收集以下信息：\n\n1. 账户信息：手机号码，用于登录验证和账户识别。\n2. 设备信息：设备型号、操作系统版本、设备标识符，用于推送通知和安全认证。\n3. 使用数据：功能使用频率、操作日志，用于服务改进和问题排查。\n4. 主机连接数据：主机名、IP 地址（仅在连接时临时使用），用于远程管理功能。"),

    ("二、信息使用",
     "我们收集的信息仅用于以下目的：\n\n1. 提供核心服务：账户认证、会话管理、远程控制。\n2. 推送通知：任务完成、错误提醒、主机状态变更。\n3. 服务改进：分析使用模式，优化产品体验。\n4. 安全保障：异常登录检测、欺诈防范。\n\n我们不会将您的个人信息出售给第三方。"),

    ("三、第三方服务",
     "本应用使用以下第三方服务：\n\n1. 智谱 AI（GLM-4.6）：用于自动生成会话标题，仅传输会话首条消息摘要，不传输完整对话内容。\n2. Apple Push Notification Service（APNs）：用于 iOS 推送通知。\n\n上述第三方服务有独立的隐私政策，我们建议您查阅其相关政策。"),

    ("四、数据存储与安全",
     "1. 数据存储在位于中国的云服务器上。\n2. 所有网络通信均通过 HTTPS/WSS 加密传输。\n3. 敏感信息（如认证令牌）使用 iOS Keychain 安全存储。\n4. 数据库采用加密存储，定期备份。"),

    ("五、用户权利",
     "您享有以下权利：\n\n1. 查看权：随时查看您的账户信息和使用数据。\n2. 删除权：请求删除您的账户和所有相关数据。\n3. 导出权：请求导出您的会话历史数据。\n4. 撤回同意权：随时撤回对数据处理的同意。\n\n行使上述权利，请通过应用内「帮助与反馈」联系我们。"),

    ("六、未成年人保护",
     "本服务不面向 14 岁以下未成年人。如您为未成年人，请在监护人指导下使用本服务。"),

    ("七、政策更新",
     "我们可能不时更新本隐私政策。重大变更将通过应用内通知或电子邮件告知您。继续使用本服务即表示您同意更新后的政策。"),

    ("八、联系我们",
     "如您对本隐私政策有任何疑问，请通过以下方式联系我们：\n\n邮箱：james_2001_2001@163.com")
]

private let userAgreementSections: [(String, String)] = [
    ("一、服务说明",
     "pocketctl 是一款远程 AI 编程助手管理工具。通过本服务，您可以：\n\n1. 远程监控运行在开发机上的 AI 编程会话（如 Claude Code、Codex）。\n2. 查看会话状态、消息历史、工具调用详情。\n3. 通过移动设备发送消息和管理会话。\n4. 接收任务完成和错误提醒的推送通知。"),

    ("二、账户注册与安全",
     "1. 您需要通过手机号码验证注册账户。\n2. 您应妥善保管账户信息，不得将账户转让或借给他人使用。\n3. 您对账户下的所有活动承担责任。\n4. 如发现账户被盗用，请立即联系我们。"),

    ("三、使用规范",
     "您同意在使用本服务时：\n\n1. 遵守中华人民共和国法律法规。\n2. 不利用本服务从事违法活动或侵犯他人权益。\n3. 不尝试攻击、干扰或破坏服务的正常运行。\n4. 不利用本服务对他人计算机系统进行未授权访问。"),

    ("四、知识产权",
     "1. pocketctl 软件、界面设计、商标等知识产权归我们所有。\n2. 您通过本服务创建的内容（如会话记录）归您所有。\n3. 您授予我们在提供服务范围内使用您内容的必要许可。"),

    ("五、付费条款",
     "1. 本服务目前提供免费使用。\n2. 未来可能推出付费订阅计划，届时将另行公告。\n3. 付费服务的具体条款将在订阅页面明确说明。"),

    ("六、服务变更与中断",
     "1. 我们保留随时修改或中断服务的权利。\n2. 重大变更将提前 30 天通知用户。\n3. 因不可抗力导致的服务中断，我们不承担责任。"),

    ("七、免责声明",
     "1. 本服务按「现状」提供，不做任何明示或暗示的保证。\n2. 对于因使用本服务造成的任何直接或间接损失，我们的赔偿责任不超过您在过去 12 个月内支付的费用总额。\n3. 您应自行备份重要数据，我们不对数据丢失承担责任。"),

    ("八、协议终止",
     "1. 您可随时通过应用内「退出登录」并联系客服删除账户来终止本协议。\n2. 我们保留在您违反本协议时终止服务的权利。\n3. 协议终止后，我们将在合理期限内删除您的数据。"),

    ("九、适用法律与争议解决",
     "1. 本协议受中华人民共和国法律管辖。\n2. 如有争议，双方应友好协商解决。\n3. 协商不成的，任何一方可向我们所在地人民法院提起诉讼。")
]
