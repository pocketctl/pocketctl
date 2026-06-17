import SwiftUI
import AVFoundation

/// QR scan-login page: scans the QR shown by the web client, parses the
/// `qr_token`, then asks the user to confirm before calling
/// `/api/auth/qr/confirm`. Mirrors the design in ui-design/screens/scan-login.html.
struct ScanLoginView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var scannedToken: String?
    @State private var scannedSource: String = ""
    @State private var isConfirming = false
    @State private var error: String?
    @State private var didSucceed = false
    private let apiClient = APIClient()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Camera preview layer
            ScannerView(onResult: { payload in
                handleScan(payload)
            })
            .ignoresSafeArea()

            // Foreground overlay
            VStack(spacing: 0) {
                navBar
                Spacer()
                scanFrameOverlay
                Spacer()
                hintSection
                    .padding(.bottom, 24)
            }

            // Success toast
            if didSucceed {
                successOverlay
            }

            // Confirmation bottom sheet
            if let token = scannedToken {
                confirmationSheet(qrToken: token)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.3), value: scannedToken)
        .animation(.easeInOut(duration: 0.3), value: didSucceed)
    }

    // MARK: - Nav bar

    private var navBar: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                    Text("返回").font(PCFont.body(15, weight: .medium))
                }
                .foregroundStyle(Color.pcAccent)
            }
            Text("扫描二维码")
                .font(PCFont.display(17, weight: .semibold))
                .foregroundStyle(.white)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    // MARK: - Scan frame

    private var scanFrameOverlay: some View {
        ZStack {
            // Four corner brackets
            ScanCorners()
                .stroke(Color.pcAccent, lineWidth: 3)
                .frame(width: 240, height: 240)

            // Animated scan line
            ScanLine()
                .frame(width: 220, height: 2)
                .opacity(scannedToken == nil ? 1 : 0.3)
        }
    }

    // MARK: - Hint

    private var hintSection: some View {
        VStack(spacing: 6) {
            Text("将 **网页端** 显示的二维码对准取景框")
            Text("扫描后在 App 内确认即可授权登录")
        }
        .font(PCFont.body(14))
        .foregroundStyle(Color.white.opacity(0.7))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
    }

    // MARK: - Confirmation sheet

    private func confirmationSheet(qrToken: String) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: PCRadius.md)
                            .fill(Color.pcAccentMuted)
                            .frame(width: 44, height: 44)
                        Image(systemName: "laptopcomputer")
                            .font(.system(size: 20))
                            .foregroundStyle(Color.pcAccent)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(scannedSource.isEmpty ? "网页端登录请求" : scannedSource)
                            .font(PCFont.body(15, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                        Text("扫码授权 · 刚刚")
                            .font(PCFont.mono(12))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                    Spacer()
                }
                Text("确认在以上设备登录 pocketctl 网页端？确认后该浏览器将获得你的账户访问权限。")
                    .font(PCFont.body(12))
                    .foregroundStyle(Color.pcFgSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let error {
                    Text(error)
                        .font(PCFont.body(12))
                        .foregroundStyle(Color.pcError)
                }

                HStack(spacing: 10) {
                    Button {
                        withAnimation { scannedToken = nil; error = nil }
                    } label: {
                        Text("取消")
                            .font(PCFont.body(15, weight: .semibold))
                            .foregroundStyle(Color.pcFgSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.pcSurface)
                            .overlay(
                                RoundedRectangle(cornerRadius: PCRadius.md)
                                    .stroke(Color.pcBorder, lineWidth: 1)
                            )
                            .cornerRadius(PCRadius.md)
                    }
                    .disabled(isConfirming)

                    Button {
                        Task { await confirm(token: qrToken) }
                    } label: {
                        HStack(spacing: 8) {
                            if isConfirming { ProgressView().tint(.black) }
                            Text(isConfirming ? "确认中..." : "确认登录")
                                .font(PCFont.body(15, weight: .semibold))
                                .foregroundStyle(.black)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.pcAccent)
                        .cornerRadius(PCRadius.md)
                    }
                    .disabled(isConfirming)
                }
            }
            .padding(20)
            .background(Color.pcSurface)
            .overlay(
                RoundedRectangle(cornerRadius: PCRadius.lg)
                    .stroke(Color.pcBorder, lineWidth: 1)
            )
            .cornerRadius(PCRadius.lg)
            .shadow(color: .black.opacity(0.5), radius: 20, y: -4)
            .padding(.horizontal, 16)
            .padding(.bottom, 36)
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
        .background(Color.clear)
    }

    // MARK: - Success overlay

    private var successOverlay: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.pcSuccess)
                Text("授权成功")
                    .font(PCFont.display(17, weight: .semibold))
                    .foregroundStyle(.white)
                Text("网页端已登录")
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.white.opacity(0.7))
            }
            .padding(32)
            .background(Color.pcSurface)
            .cornerRadius(PCRadius.lg)
        }
    }

    // MARK: - Actions

    private func handleScan(_ payload: String) {
        // De-duplicate: ignore scans while a sheet is up.
        guard scannedToken == nil, !isConfirming, !didSucceed else { return }
        guard let token = parseQrToken(from: payload) else { return }
        // Light haptic
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.impactOccurred()
        scannedSource = parseSource(from: payload)
        withAnimation { scannedToken = token }
    }

    /// Extract `token` query param from the QR payload URL.
    private func parseQrToken(from payload: String) -> String? {
        // Payload format: "<WEB_APP_URL>/login/qr?token=<token>"
        if let url = URL(string: payload),
           let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let item = comps.queryItems?.first(where: { $0.name == "token" }),
           let v = item.value, !v.isEmpty {
            return v
        }
        // Fallback: treat the whole payload as a bare token if it looks like one
        // (alphanumeric, reasonable length).
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.rangeOfCharacter(from: CharacterSet.alphanumerics.inverted) == nil,
           trimmed.count >= 16 {
            return trimmed
        }
        return nil
    }

    /// Best-effort source label (host) for the scanned URL.
    private func parseSource(from payload: String) -> String {
        guard let url = URL(string: payload) else { return "" }
        return url.host ?? ""
    }

    private func confirm(token: String) async {
        isConfirming = true
        error = nil
        do {
            _ = try await apiClient.confirmQrLogin(qrToken: token)
            withAnimation { didSucceed = true }
            // Dismiss shortly after showing success.
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        isConfirming = false
    }
}

// MARK: - Corner brackets

private struct ScanCorners: Shape {
    var radius: CGFloat = 14

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let c: CGFloat = 30 // corner length
        // Top-left
        p.move(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        p.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY),
                       control: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX + c, y: rect.minY))
        // Top-right
        p.move(to: CGPoint(x: rect.maxX - radius, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + radius),
                       control: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + c))
        // Bottom-left
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY - radius))
        p.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.maxY),
                       control: CGPoint(x: rect.minX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + c, y: rect.maxY))
        // Bottom-right
        p.move(to: CGPoint(x: rect.maxX - radius, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY - radius),
                       control: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - c))
        return p
    }
}

// MARK: - Animated scan line

private struct ScanLine: View {
    @State private var topOffset: CGFloat = -100

    var body: some View {
        LinearGradient(colors: [.clear, Color.pcAccent, Color.pcAccent, .clear],
                       startPoint: .leading, endPoint: .trailing)
            .shadow(color: Color.pcAccent.opacity(0.8), radius: 6)
            .offset(y: topOffset)
            .onAppear {
                withAnimation(.timingCurve(0.4, 0, 0.2, 1, duration: 2.6).repeatForever(autoreverses: true)) {
                    topOffset = 100
                }
            }
    }
}

// MARK: - AVFoundation scanner (UIViewRepresentable)

private struct ScannerView: UIViewRepresentable {
    let onResult: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.backgroundColor = .black
        v.session = context.coordinator.session
        context.coordinator.start()
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        let onResult: (String) -> Void
        private let queue = DispatchQueue(label: "pocketctl.qr.scanner")

        init(onResult: @escaping (String) -> Void) { self.onResult = onResult }

        func start() {
            queue.async { [weak self] in
                guard let self else { return }
                guard let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device),
                      self.session.canAddInput(input) else { return }
                self.session.addInput(input)

                let output = AVCaptureMetadataOutput()
                if self.session.canAddOutput(output) {
                    self.session.addOutput(output)
                    output.metadataObjectTypes = [.qr]
                    output.setMetadataObjectsDelegate(self, queue: .main)
                }
                self.session.startRunning()
            }
        }

        func stop() {
            queue.async { [weak self] in
                self?.session.stopRunning()
            }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = obj.stringValue else { return }
            onResult(value)
        }
    }
}

/// Simple UIView that hosts an AVCaptureVideoPreviewLayer.
final class PreviewView: UIView {
    var session: AVCaptureSession? {
        didSet {
            guard let session else { return }
            layer.addSublayer(makePreviewLayer(for: session))
        }
    }

    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    private func makePreviewLayer(for session: AVCaptureSession) -> CALayer {
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = bounds
        // Keep frame synced on layout changes.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            preview.frame = self.bounds
        }
        return preview
    }
}
