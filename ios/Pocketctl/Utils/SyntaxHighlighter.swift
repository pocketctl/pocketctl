import SwiftUI

/// Simple regex-based syntax highlighter for common languages
enum SyntaxHighlighter {

    // MARK: - Token types

    enum TokenType {
        case keyword
        case string
        case comment
        case number
        case function
        case type
        case `operator`
        case variable
        case property
        case plain

        var color: Color {
            switch self {
            case .keyword: return .pcSyntaxKeyword
            case .string: return .pcSyntaxString
            case .comment: return .pcSyntaxComment
            case .number: return .pcSyntaxNumber
            case .function: return .pcSyntaxFunction
            case .type: return .pcSyntaxType
            case .operator: return .pcSyntaxOperator
            case .variable: return .pcSyntaxVariable
            case .property: return .pcSyntaxProperty
            case .plain: return .pcFg
            }
        }
    }

    // MARK: - Highlight

    /// Highlight code and return an AttributedString
    static func highlight(_ code: String, language: String?) -> AttributedString {
        let lang = (language ?? "").lowercased()
        let tokens = tokenize(code, language: lang)
        return buildAttributedString(tokens)
    }

    // MARK: - Tokenizer

    private struct Token {
        let text: String
        let type: TokenType
    }

    private static func tokenize(_ code: String, language: String) -> [Token] {
        let keywords = keywordsForLanguage(language)
        let types = typesForLanguage(language)

        var tokens: [Token] = []
        let lines = code.components(separatedBy: "\n")

        for (lineIndex, line) in lines.enumerated() {
            if lineIndex > 0 {
                tokens.append(Token(text: "\n", type: .plain))
            }
            tokens.append(contentsOf: tokenizeLine(line, keywords: keywords, types: types))
        }

        return tokens
    }

    private static func tokenizeLine(_ line: String, keywords: Set<String>, types: Set<String>) -> [Token] {
        var tokens: [Token] = []
        var remaining = line

        while !remaining.isEmpty {
            // Try to match patterns in order of priority
            if let token = matchComment(&remaining) {
                tokens.append(token)
            } else if let token = matchString(&remaining) {
                tokens.append(token)
            } else if let token = matchNumber(&remaining) {
                tokens.append(token)
            } else if let token = matchIdentifier(&remaining, keywords: keywords, types: types) {
                tokens.append(token)
            } else if let token = matchOperator(&remaining) {
                tokens.append(token)
            } else {
                // Plain character
                let char = String(remaining.removeFirst())
                tokens.append(Token(text: char, type: .plain))
            }
        }

        return tokens
    }

    // MARK: - Pattern matchers

    private static func matchComment(_ input: inout String) -> Token? {
        // Single line comment: // or #
        if input.hasPrefix("//") {
            let comment = input
            input = ""
            return Token(text: comment, type: .comment)
        }
        if input.hasPrefix("#") && !input.hasPrefix("#!") {
            let comment = input
            input = ""
            return Token(text: comment, type: .comment)
        }
        return nil
    }

    private static func matchString(_ input: inout String) -> Token? {
        let quotes: [Character] = ["\"", "'", "`"]
        guard let first = input.first, quotes.contains(first) else { return nil }

        var result = String(first)
        input.removeFirst()

        while !input.isEmpty {
            let char = input.removeFirst()
            result.append(char)
            if char == first && !result.hasSuffix("\\") {
                break
            }
        }

        return Token(text: result, type: .string)
    }

    private static func matchNumber(_ input: inout String) -> Token? {
        guard let first = input.first, first.isNumber else { return nil }

        var result = ""
        while !input.isEmpty {
            let char = input.first!
            if char.isNumber || char == "." || char == "_" || char == "x" || char == "X" || (char >= "a" && char <= "f") || (char >= "A" && char <= "F") {
                result.append(input.removeFirst())
            } else {
                break
            }
        }

        return Token(text: result, type: .number)
    }

    private static func matchIdentifier(_ input: inout String, keywords: Set<String>, types: Set<String>) -> Token? {
        guard let first = input.first, first.isLetter || first == "_" else { return nil }

        var result = ""
        while !input.isEmpty {
            let char = input.first!
            if char.isLetter || char.isNumber || char == "_" {
                result.append(input.removeFirst())
            } else {
                break
            }
        }

        // Check if it's followed by ( → function call
        if input.hasPrefix("(") {
            return Token(text: result, type: .function)
        }

        // Check if it's a keyword
        if keywords.contains(result) {
            return Token(text: result, type: .keyword)
        }

        // Check if it's a type
        if types.contains(result) {
            return Token(text: result, type: .type)
        }

        return Token(text: result, type: .plain)
    }

    private static func matchOperator(_ input: inout String) -> Token? {
        let operators: Set<Character> = ["+", "-", "*", "/", "=", "!", "<", ">", "&", "|", "^", "~", "%", "?", ":", "@", "."]
        guard let first = input.first, operators.contains(first) else { return nil }

        var result = ""
        while !input.isEmpty {
            let char = input.first!
            if operators.contains(char) {
                result.append(input.removeFirst())
            } else {
                break
            }
        }

        return Token(text: result, type: .operator)
    }

    // MARK: - Language definitions

    private static func keywordsForLanguage(_ language: String) -> Set<String> {
        switch language {
        case "go":
            return ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"]
        case "javascript", "js", "typescript", "ts":
            return ["abstract", "arguments", "async", "await", "boolean", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "of", "package", "private", "protected", "public", "return", "set", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with", "yield"]
        case "python", "py":
            return ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "True", "False", "None"]
        case "swift":
            return ["associatedtype", "class", "deinit", "enum", "extension", "func", "import", "init", "inout", "internal", "let", "operator", "private", "protocol", "public", "static", "struct", "subscript", "typealias", "var", "break", "case", "continue", "default", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "switch", "where", "while", "as", "catch", "false", "is", "nil", "rethrows", "super", "self", "Self", "throw", "throws", "true", "try", "convenience", "dynamic", "final", "lazy", "mutating", "nonmutating", "optional", "override", "required", "unowned", "weak"]
        case "bash", "sh", "zsh":
            return ["if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done", "in", "function", "return", "exit", "export", "source", "alias", "bg", "fg", "jobs", "kill", "wait", "cd", "pwd", "echo", "printf", "read", "test", "set", "unset", "shift", "exec", "eval", "trap", "type", "hash", "help", "true", "false"]
        case "sql":
            return ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "EXISTS", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "AS", "GROUP", "BY", "ORDER", "ASC", "DESC", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "CASE", "WHEN", "THEN", "ELSE", "END", "BEGIN", "COMMIT", "ROLLBACK", "GRANT", "REVOKE", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CONSTRAINT", "UNIQUE", "CHECK", "DEFAULT", "AUTO_INCREMENT", "SERIAL", "NOW", "INTERVAL"]
        case "json":
            return [] // JSON has no keywords, just structure
        case "html", "xml":
            return ["DOCTYPE", "html", "head", "body", "div", "span", "p", "a", "img", "ul", "ol", "li", "table", "tr", "td", "th", "form", "input", "button", "script", "style", "link", "meta", "title", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr"]
        case "css":
            return ["color", "background", "margin", "padding", "border", "font", "display", "position", "width", "height", "top", "left", "right", "bottom", "flex", "grid", "transform", "transition", "animation", "opacity", "overflow", "z-index", "text-align", "font-size", "font-weight", "line-height", "box-shadow", "text-decoration", "cursor", "pointer"]
        default:
            return ["if", "else", "for", "while", "return", "function", "func", "def", "class", "struct", "var", "let", "const", "true", "false", "null", "nil", "None", "import", "package", "export", "from", "async", "await", "try", "catch", "throw", "new", "this", "self", "super"]
        }
    }

    private static func typesForLanguage(_ language: String) -> Set<String> {
        switch language {
        case "go":
            return ["bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "any", "comparable"]
        case "javascript", "js", "typescript", "ts":
            return ["Array", "Boolean", "Date", "Error", "Function", "Map", "Number", "Object", "Promise", "RegExp", "Set", "String", "Symbol", "WeakMap", "WeakSet", "any", "boolean", "never", "number", "string", "void", "undefined", "null"]
        case "python", "py":
            return ["int", "float", "str", "bool", "list", "dict", "tuple", "set", "bytes", "None", "object", "type", "Exception", "ValueError", "TypeError", "KeyError", "IndexError", "RuntimeError", "StopIteration"]
        case "swift":
            return ["Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64", "Float", "Float32", "Float64", "Double", "Bool", "String", "Character", "Array", "Dictionary", "Set", "Optional", "Error", "Result", "Any", "AnyObject", "Void", "Never", "Codable", "Identifiable", "Hashable", "Equatable", "Comparable", "Sendable"]
        case "sql":
            return ["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "VARCHAR", "CHAR", "TEXT", "BLOB", "CLOB", "DATE", "TIME", "TIMESTAMP", "DATETIME", "BOOLEAN", "BOOL", "JSON", "JSONB", "UUID", "SERIAL", "BIGSERIAL"]
        default:
            return ["string", "int", "float", "bool", "error", "any", "void", "null", "undefined"]
        }
    }

    // MARK: - AttributedString builder

    private static func buildAttributedString(_ tokens: [Token]) -> AttributedString {
        var result = AttributedString()

        for token in tokens {
            var attrStr = AttributedString(token.text)
            attrStr.foregroundColor = token.type.color
            attrStr.font = PCFont.mono(13)
            result.append(attrStr)
        }

        return result
    }
}
