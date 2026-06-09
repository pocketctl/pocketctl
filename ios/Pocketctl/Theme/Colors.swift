import SwiftUI

/// Design system color tokens — aligned with shared.css
extension Color {
    // Background
    static let pcBackground = Color(hex: 0x0D1117)
    static let pcSurface = Color(hex: 0x161B22)
    static let pcHoverInput = Color(hex: 0x1C2129)
    static let pcBorder = Color(hex: 0x21262D)
    static let pcBorderLight = Color(hex: 0x30363D)

    // Accent
    static let pcAccent = Color(hex: 0x58A6FF)
    static let pcAccentHover = Color(hex: 0x79C0FF)
    static let pcAccentMuted = Color(red: 0.345, green: 0.651, blue: 1.0, opacity: 0.15)
    static let pcAccentSubtle = Color(red: 0.345, green: 0.651, blue: 1.0, opacity: 0.10)

    // Primary button
    static let pcPrimaryBtn = Color(hex: 0x238636)
    static let pcPrimaryBtnHover = Color(hex: 0x2EA043)

    // Foreground
    static let pcFg = Color(hex: 0xE6EDF3)
    static let pcFgSecondary = Color(hex: 0x8B949E)
    static let pcFgTertiary = Color(hex: 0x484F58)

    // Chat bubbles
    static let pcUserBubble = Color(hex: 0x1F6FEB)

    // Status
    static let pcError = Color(hex: 0xF85149)
    static let pcErrorBg = Color(hex: 0x3D1214)
    static let pcSuccess = Color(hex: 0x3FB950)
    static let pcSuccessBg = Color(red: 0.137, green: 0.525, blue: 0.216, opacity: 0.15)
    static let pcWarning = Color(hex: 0xD29922)
    static let pcWarningBg = Color(red: 0.824, green: 0.6, blue: 0.133, opacity: 0.15)

    // Sub-agent
    static let pcSubAgent = Color(hex: 0xC084FC)
    static let pcSubAgentBg = Color(hex: 0x2D1A3E)

    // Near-black for code blocks
    static let pcCodeBg = Color(hex: 0x010409)

    // Syntax highlighting (GitHub Dark theme)
    static let pcSyntaxKeyword = Color(hex: 0xFF7B72)   // if, func, return, let
    static let pcSyntaxString = Color(hex: 0xA5D6FF)    // "hello", 'world'
    static let pcSyntaxComment = Color(hex: 0x8B949E)   // // comment
    static let pcSyntaxNumber = Color(hex: 0x79C0FF)    // 123, 3.14
    static let pcSyntaxFunction = Color(hex: 0xD2A8FF)  // myFunc()
    static let pcSyntaxType = Color(hex: 0xFFA657)      // string, int, error
    static let pcSyntaxOperator = Color(hex: 0xFF7B72)   // +, -, =, :=
    static let pcSyntaxVariable = Color(hex: 0xE6EDF3)  // variables
    static let pcSyntaxProperty = Color(hex: 0x79C0FF)  // object.property
}

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
