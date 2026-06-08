import SwiftUI

struct LoginView: View {
    @Binding var isLoggedIn: Bool

    @State private var phoneText = ""
    private let apiClient = APIClient()
    @FocusState private var phoneFocused: Bool
    @FocusState private var focusedCodeIndex: Int?
    @State private var codeDigits: [String] = Array(repeating: "", count: 6)
    @State private var countdown = 0
    @State private var isLoading = false
    @State private var error: String?
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
        (Text("登录即同意").foregroundStyle(Color.pcFgTertiary)
         + Text("《用户协议》").foregroundStyle(Color.pcAccent)
         + Text("和").foregroundStyle(Color.pcFgTertiary)
         + Text("《隐私政策》").foregroundStyle(Color.pcAccent))
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
            isLoggedIn = true
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
