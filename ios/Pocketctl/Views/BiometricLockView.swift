import SwiftUI

/// 生物认证锁屏视图。进入后立即弹出系统生物认证(Face ID / Touch ID),
/// 认证通过调用 onSuccess 进入主界面;用户取消或认证失败后显示重试按钮。
struct BiometricLockView: View {
    let onSuccess: () -> Void

    @State private var hasFailed = false

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                Image(systemName: hasFailed ? "lock.fill" : BiometricAuthService.displayName == "Face ID" ? "faceid" : "touchid")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.pcAccent)

                VStack(spacing: 8) {
                    Text(hasFailed ? "认证失败" : "\(BiometricAuthService.displayName) 已锁定")
                        .font(PCFont.display(20, weight: .semibold))
                        .foregroundStyle(Color.pcFg)

                    Text(hasFailed ? "请重新进行生物认证" : "通过生物认证以进入 App")
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgSecondary)
                }

                Spacer()

                if hasFailed {
                    Button {
                        authenticate()
                    } label: {
                        Text("重新认证")
                            .font(PCFont.body(16, weight: .semibold))
                            .foregroundStyle(Color.pcBackground)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.pcAccent)
                            .clipShape(RoundedRectangle(cornerRadius: PCRadius.lg))
                    }
                    .padding(.horizontal, PCSpacing.xl)
                }
            }
            .padding(.bottom, 80)
        }
        .task {
            // 进入锁屏即自动触发一次认证。
            authenticate()
        }
    }

    private func authenticate() {
        Task {
            let ok = await BiometricAuthService.authenticate(reason: "通过认证以进入 pocketctl")
            if ok {
                onSuccess()
            } else {
                hasFailed = true
            }
        }
    }
}
