import SwiftUI

/// Typography tokens — SF Pro Display / Text / Mono
enum PCFont {
    // Display (titles, headings, large buttons)
    static func display(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Body (labels, descriptions, form text)
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    // Mono (code, session IDs, terminal content)
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
