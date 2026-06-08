import SwiftUI

struct SplashView: View {
    @State private var progressOffset: CGFloat = -120

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            VStack(spacing: 12) {
                // Logo
                Image(systemName: "terminal.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.pcAccent)

                // Wordmark
                Text("pocketctl")
                    .font(PCFont.display(32, weight: .bold))
                    .foregroundStyle(Color.pcAccent)
                    .kerning(-0.5)

                // Tagline
                Text("Your coding agents, in your pocket.")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFgSecondary)
            }

            // Progress bar at bottom
            VStack {
                Spacer()
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.pcBorder)
                        .frame(width: 120, height: 3)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.pcAccent)
                        .frame(width: 48, height: 3)
                        .offset(x: progressOffset)
                }
                .padding(.bottom, 80)
            }
        }
        .onAppear {
            withAnimation(
                .easeInOut(duration: 2.0)
                .repeatForever(autoreverses: false)
            ) {
                progressOffset = 120
            }
        }
    }
}
