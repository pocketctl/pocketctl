import Foundation

/// Chinese relative time formatting — matches useRelativeTime.ts
enum RelativeTime {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let altFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// 输出 Formatter（"MM-dd HH:mm"）— 缓存为静态常量，避免每张卡片渲染时都 new。
    private static let outputFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    static func format(_ isoString: String?) -> String {
        guard let isoString, !isoString.isEmpty else { return "" }

        let date: Date
        if let d = formatter.date(from: isoString) {
            date = d
        } else if let d = altFormatter.date(from: isoString) {
            date = d
        } else {
            return ""
        }

        let interval = -date.timeIntervalSinceNow

        if interval < 60 { return "刚刚" }
        if interval < 3600 { return "\(Int(interval / 60))分钟前" }
        if interval < 86400 { return "\(Int(interval / 3600))小时前" }

        return outputFormatter.string(from: date)
    }
}
