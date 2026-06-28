import Foundation

/// Diff rendering helpers — turn Edit/MultiEdit/Write tool inputs into
/// structured line-level diff data for DiffCard. Swift port of the web client's
/// `utils/diffRender.ts` (line-level LCS so a single changed line inside a large
/// old_string only flags the changed line, not the whole block).
///
/// Data source: the tool_call's raw `input` JSON (ChatMessage.rawInputJSON),
/// passed through transparently from Claude Code's transcript.jsonl.

enum DiffLineType {
    case add, del, ctx
}

struct DiffLine: Identifiable {
    let id = UUID()
    let type: DiffLineType
    let text: String
    /// 1-based line number in the old file. nil for pure additions.
    let oldLine: Int?
    /// 1-based line number in the new file. nil for pure deletions.
    let newLine: Int?
}

struct DiffBlock: Identifiable {
    let id = UUID()
    /// For MultiEdit: 1-based edit index. For Edit/Write: nil.
    let index: Int?
    var lines: [DiffLine]
    let additions: Int
    let deletions: Int
}

/// Tools whose input we can render as a line-level diff.
let DIFF_TOOLS: Set<String> = ["Edit", "MultiEdit", "Write"]

func isDiffTool(_ tool: String?) -> Bool {
    guard let tool else { return false }
    return DIFF_TOOLS.contains(tool)
}

/// Hard cap to keep rendering fast on pathological inputs.
private let MAX_DIFF_LINES = 4000

/// Split a string into lines, stripping a single trailing newline (matches the
/// web's `/\n$/` trim). Empty string → no lines.
private func splitLines(_ s: String) -> [String] {
    if s.isEmpty { return [] }
    var t = s
    if t.hasSuffix("\n") { t.removeLast() }
    return t.components(separatedBy: "\n")
}

/// Compute a single diff block from an old/new pair using a line-level LCS.
private func diffPair(_ oldStr: String, _ newStr: String, index: Int?) -> DiffBlock {
    let a = splitLines(oldStr)
    let b = splitLines(newStr)
    let m = a.count, n = b.count

    // Suffix-LCS lengths: dp[i][j] = LCS(a[i...], b[j...]).
    var dp = [[Int]](repeating: [Int](repeating: 0, count: n + 1), count: m + 1)
    if m > 0 && n > 0 {
        for i in stride(from: m - 1, through: 0, by: -1) {
            for j in stride(from: n - 1, through: 0, by: -1) {
                dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
            }
        }
    }

    var lines: [DiffLine] = []
    var oldNo = 0, newNo = 0
    var additions = 0, deletions = 0
    var i = 0, j = 0

    while i < m && j < n {
        if a[i] == b[j] {
            oldNo += 1; newNo += 1
            lines.append(DiffLine(type: .ctx, text: a[i], oldLine: oldNo, newLine: newNo))
            i += 1; j += 1
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            oldNo += 1
            lines.append(DiffLine(type: .del, text: a[i], oldLine: oldNo, newLine: nil))
            deletions += 1; i += 1
        } else {
            newNo += 1
            lines.append(DiffLine(type: .add, text: b[j], oldLine: nil, newLine: newNo))
            additions += 1; j += 1
        }
        if lines.count > MAX_DIFF_LINES { break }
    }
    while i < m && lines.count <= MAX_DIFF_LINES {
        oldNo += 1
        lines.append(DiffLine(type: .del, text: a[i], oldLine: oldNo, newLine: nil))
        deletions += 1; i += 1
    }
    while j < n && lines.count <= MAX_DIFF_LINES {
        newNo += 1
        lines.append(DiffLine(type: .add, text: b[j], oldLine: nil, newLine: newNo))
        additions += 1; j += 1
    }

    return DiffBlock(index: index, lines: lines, additions: additions, deletions: deletions)
}

/// Treat content with no old version as a pure addition (all green).
private func addedBlock(_ content: String, index: Int?) -> DiffBlock {
    var lines: [DiffLine] = []
    var newNo = 0
    for text in splitLines(content) {
        newNo += 1
        lines.append(DiffLine(type: .add, text: text, oldLine: nil, newLine: newNo))
        if lines.count > MAX_DIFF_LINES { break }
    }
    return DiffBlock(index: index, lines: lines, additions: lines.count, deletions: 0)
}

/// Decode the raw input JSON into a dictionary.
private func parseInput(_ json: String?) -> [String: Any]? {
    guard let json, let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj
}

/// Build one or more diff blocks from a tool_call input JSON.
/// - Edit: single block from old_string → new_string
/// - Write: single all-addition block from content (new file)
/// - MultiEdit: one block per entry in edits[]
/// - Anything else / malformed input: []
func buildDiffBlocks(inputJSON: String?, tool: String?) -> [DiffBlock] {
    guard let tool, let input = parseInput(inputJSON) else { return [] }

    switch tool {
    case "Edit":
        let oldStr = input["old_string"] as? String ?? ""
        let newStr = input["new_string"] as? String ?? ""
        if oldStr.isEmpty && newStr.isEmpty { return [] }
        return [diffPair(oldStr, newStr, index: nil)]

    case "Write":
        let content = input["content"] as? String ?? ""
        if content.isEmpty { return [] }
        return [addedBlock(content, index: nil)]

    case "MultiEdit":
        let edits = input["edits"] as? [[String: Any]] ?? []
        var blocks: [DiffBlock] = []
        for (i, e) in edits.enumerated() {
            let oldStr = e["old_string"] as? String ?? ""
            let newStr = e["new_string"] as? String ?? ""
            if oldStr.isEmpty && newStr.isEmpty { continue }
            blocks.append(diffPair(oldStr, newStr, index: i + 1))
        }
        return blocks

    default:
        return []
    }
}

/// Total additions/deletions across all blocks (for header summary).
func sumChanges(_ blocks: [DiffBlock]) -> (additions: Int, deletions: Int) {
    blocks.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
}

/// Best-effort file path extraction from input (for the card header).
func diffFilePath(inputJSON: String?) -> String {
    guard let input = parseInput(inputJSON) else { return "" }
    return (input["file_path"] as? String) ?? (input["path"] as? String) ?? ""
}
