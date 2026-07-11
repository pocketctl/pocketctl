import type { CommandItem } from '../composables/useWebSocket'

export const POCKETCTL_LOCAL_COMMANDS: CommandItem[] = [
  { name: 'cost', source: 'pocketctl', kind: 'command', description: '查看 token 用量与花费' },
  { name: 'status', source: 'pocketctl', kind: 'command', description: '查看主机、模型与版本摘要' },
  { name: 'help', source: 'pocketctl', kind: 'command', description: '查看 Pocketctl 本地命令说明' },
  { name: 'model', source: 'pocketctl', kind: 'command', description: '查看当前模型；切换模型请在终端执行 /model', arg_hint: '<model>' },
]

export function mergeLocalCommands(commands: CommandItem[]): CommandItem[] {
  const localNames = new Set(POCKETCTL_LOCAL_COMMANDS.map(command => command.name))
  return [
    ...POCKETCTL_LOCAL_COMMANDS,
    ...commands.filter(command => !localNames.has(command.name)),
  ]
}
