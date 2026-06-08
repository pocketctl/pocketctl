import SwiftUI

struct EmptyStateView: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(Color.pcFgTertiary)
                .opacity(0.4)

            Text(title)
                .font(PCFont.display(20, weight: .semibold))
                .foregroundStyle(Color.pcFg)

            Text(subtitle)
                .font(PCFont.body(15))
                .foregroundStyle(Color.pcFgSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .padding(.vertical, 40)
        .padding(.horizontal, 24)
    }
}
