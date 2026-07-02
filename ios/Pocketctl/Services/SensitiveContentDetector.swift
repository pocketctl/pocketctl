import Foundation

/// 敏感信息检测:扫描用户即将发送的消息内容,识别可能包含的密码、密钥、
/// token 等敏感凭据。命中时 UI 弹风险确认,避免误发给 AI agent 导致泄露。
///
/// 设计原则:
/// - 宁可误报(提示用户确认)也不漏报(凭据直接发出)
/// - 检测常见凭据模式:password/token/secret/key 赋值、PEM 私钥、Bearer token
/// - 纯启发式,无网络调用,不存储内容
enum SensitiveContentDetector {

    struct Match {
        let reason: String  // 给用户看的命中说明(如"疑似密码")
    }

    /// 检测文本是否包含疑似敏感信息。命中返回 Match,否则 nil。
    static func detect(_ text: String) -> Match? {
        let lower = text.lowercased()

        // PEM 私钥块(含 RSA/EC/OPENSSH PRIVATE KEY)
        if text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----") {
            return Match(reason: "疑似包含私钥(PEM)")
        }

        // Bearer / Authorization token
        if lower.contains("bearer ") || lower.contains("authorization:") {
            return Match(reason: "疑似包含 Authorization 凭据")
        }

        // 凭据赋值:password=xxx、api_key=xxx、token: xxx 等
        // 匹配 "password"/"passwd"/"secret"/"api_key"/"apikey"/"access_key"/"token" 后跟 = 或 : 并有值
        let credKeys = ["password", "passwd", "pwd", "secret", "api_key", "apikey", "access_key", "accesskey", "client_secret", "private_key"]
        for key in credKeys {
            // 匹配 key 紧接 =/: (允许中间有空格),且后面有非空值(至少 4 字符)
            let pattern = "\(key)[\\s]*[:=][\\s]*\\S.{3,}"
            if lower.range(of: pattern, options: .regularExpression) != nil {
                return Match(reason: "疑似包含\(labelFor(key))")
            }
        }

        // AWS 风格 key(AKIA 开头 20 字符)
        if text.range(of: "AKIA[0-9A-Z]{16}", options: .regularExpression) != nil {
            return Match(reason: "疑似包含 AWS 访问密钥")
        }

        return nil
    }

    private static func labelFor(_ key: String) -> String {
        switch key {
        case "password", "passwd", "pwd": return "密码"
        case "secret", "client_secret": return "密钥"
        case "api_key", "apikey", "access_key", "accesskey": return "API 密钥"
        case "private_key": return "私钥"
        default: return "敏感凭据"
        }
    }
}
