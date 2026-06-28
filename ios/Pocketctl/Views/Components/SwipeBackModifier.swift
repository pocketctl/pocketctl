import SwiftUI
import UIKit

/// Re-enables the system "swipe back" edge gesture for a SwiftUI `NavigationStack`.
///
/// SwiftUI disables the interactive pop gesture once the system navigation bar is
/// hidden (`.navigationBarHidden(true)`), which is exactly the case for every
/// screen in this app — they all use custom nav bars. This modifier dives into
/// the underlying `UINavigationController` and turns the recognizer back on,
/// guarded so it never fires on the root level (which would otherwise freeze
/// the whole navigation stack — a classic footgun of this technique).
///
/// Attach it once to the root `NavigationStack` and every pushed screen inherits it.
struct SwipeBackModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.background(
            NavigatorSwiperInjector()
                .frame(width: 0, height: 0)
                .opacity(0)
        )
    }
}

extension View {
    /// Enable the iOS edge-swipe-to-pop gesture for this NavigationStack.
    func enableSwipeBack() -> some View { modifier(SwipeBackModifier()) }
}

/// Zero-size `UIViewControllerRepresentable` used to reach the host
/// `UINavigationController` from the SwiftUI tree.
private struct NavigatorSwiperInjector: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        let vc = UIViewController()
        // Defer until the view has been inserted into the hierarchy — the parent
        // UINavigationController is not yet wired up at creation time.
        DispatchQueue.main.async {
            guard let nav = vc.navigationController else { return }
            guard let pop = nav.interactivePopGestureRecognizer else { return }
            pop.delegate = context.coordinator
            pop.isEnabled = true
        }
        return vc
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        /// Only allow the gesture when there is something to pop back to.
        /// This keeps the root screen responsive (no stuck navigation stack).
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let nav = gestureRecognizer.view?.next as? UINavigationController
                ?? (gestureRecognizer.view?.window?.rootViewController as? UINavigationController)
            else { return false }
            return nav.viewControllers.count > 1
        }
    }
}
