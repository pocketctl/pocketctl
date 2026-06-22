import SwiftUI

/// Slash command autocomplete popover — floats above the input bar when the
/// user types "/" prefix. Each row shows an icon + /name + arg_hint +
/// description (+ namespace badge for plugins). Tap-to-select (no keyboard
/// arrow navigation on iOS, unlike web).
struct CommandPopoverView: View {
    let commands: [CommandItem]
    @Binding var selectedIndex: Int
    let onSelect: (CommandItem) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(commands.enumerated()), id: \.element.id) { index, cmd in
                    commandRow(cmd, isActive: index == selectedIndex)
                        .onTapGesture {
                            onSelect(cmd)
                        }
                }
            }
        }
        .background(Color.pcSurface)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
        .cornerRadius(PCRadius.md)
        .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
        .frame(maxHeight: 240)
    }

    @ViewBuilder
    private func commandRow(_ cmd: CommandItem, isActive: Bool) -> some View {
        HStack(spacing: 8) {
            // Icon
            Image(systemName: cmd.iconSymbol)
                .font(.system(size: 13))
                .foregroundStyle(Color.pcAccent)
                .frame(width: 16)

            // /name
            Text("/\(cmd.name)")
                .font(PCFont.mono(13, weight: .semibold))
                .foregroundStyle(Color.pcAccent)

            // arg_hint (optional)
            if let hint = cmd.argHint, !hint.isEmpty {
                Text(hint)
                    .font(PCFont.mono(11))
                    .foregroundStyle(Color.pcFgTertiary)
            }

            // description (fills remaining space, truncated)
            if let desc = cmd.description, !desc.isEmpty {
                Text(desc)
                    .font(PCFont.body(12))
                    .foregroundStyle(Color.pcFgSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)

            // namespace badge (only for plugins)
            if cmd.source == "plugin", let ns = cmd.namespace, !ns.isEmpty {
                Text(ns)
                    .font(PCFont.body(10))
                    .foregroundStyle(Color.pcFgTertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color.pcBackground)
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isActive ? Color.pcHoverInput : Color.clear)
        .contentShape(Rectangle())
    }
}
