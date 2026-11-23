// Keep rule matching on the opening request/receipt so code samples and tool
// names mentioned later in technical discussions don't suppress those turns.
const courtesy = /^(?:(?:麻烦|请|帮我|帮忙|给我|先|现在|直接|继续|能否|能不能)\s*)+/u
const branchContext = /^(?:在)?(?:当前|本地|这个|该)\s*(?:[\w./-]+\s*)?(?:分支|工作区)(?:上|中)?\s*/u
const englishCourtesy = /^(?:(?:please|can you|could you|go ahead and)\s+)+/i

const requests = [
  // Native skill references, slash commands and literal Git commands.
  /^(?:\/skills?\b|\/mcp\b|\/(?:commit|merge|merge-master|push-dev|status)(?:\s|$)|mcp__[\w-]+__[\w-]+)/i,
  /^\$[a-z][a-z0-9-]*(?:\s|$)|^\[\$[\w-]+\]\([^)]+\)|^<skill>/,
  /^(?:执行|运行)?\s*git\s+(?:commit|merge|status)\b/i,
  // Repository operations require a code/branch object or a standalone verb.
  /^(?:提交|合并)(?:一下|下)?(?:[。！!\s]*$|[^，。！？\n]{0,32}?(?:代码|改动|更改|修改|变更|分支|PR\b))/iu,
  /^(?:把|将)[^，。！？\n]{0,48}?(?:代码|改动|变更|分支)[^，。！？\n]{0,20}?(?:提交|合并)/u,
  /^(?:调用|使用|运行|执行|用)\s*(?:一下|这个|指定的)?\s*(?:[\w.-]+\s+)?(?:skills?\b|mcp(?:\b|__))/iu,
  /^(?:查(?:询|看)?|看(?:看)?|检查|汇报|报告|更新|跟进|同步)(?:一下|下)?\s*(?:(?:当前|目前|现在|最新|任务|项目|执行|工作|开发|处理|部署|测试|的)\s*)*(?:进度|进展)(?!条)/u,
  /^(?:(?:当前|目前|现在|任务|项目|的)\s*)*(?:进度|进展)(?:如何|怎样|怎么样|到哪|多少|呢|[?？!！。]*$)|^(?:现在|目前)?(?:做到哪|进行到哪|完成了(?:多少|吗))/u,
  /^(?:commit|merge)(?:[.!\s]*$|\s+(?:and (?:push|merge)|(?:the |these |all |my |our |this |current )*(?:changes?|code|branch|commits?|pull request|pr)\b|[\w./-]+\s+(?:into|to)\s))/i,
  /^(?:call|invoke|run|use)\s+(?:(?:the|a|an)\s+)?(?:[\w.-]+\s+)?(?:skill|mcp)\b/i,
  /^(?:查询|查看|汇报|看看)(?:一下)?[^，。！？\n]{1,28}的(?:进度|进展)[?？。！!\s]*$/u,
  /^(?:(?:give me|show me) (?:a |the )?)?(?:progress|status) update[.?!\s]*$/i,
  /^(?:check|show|report|get)\s+(?:(?:me|the|current|task|project|latest)\s+)*(?:progress|status)\b/i,
  /^(?:what(?:'s| is) (?:the )?(?:current )?(?:progress|status)|how(?:'s| is) (?:it|the task) (?:going|progressing))\b/i,
]
const receipts = [
  /^(?:已(?:经)?|成功)(?:完成)?(?:提交|合并)(?:了|到|至|代码|分支|改动|更改|变更|[：:。\s]|$)/u,
  /^(?:已(?:经)?|成功)(?:将|把)[^。\n]{1,70}?(?:合并到|提交到)/u,
  /^(?:已(?:经)?|成功)(?:调用|执行)\s*(?:skills?\b|mcp(?:\b|__))/iu,
  /^(?:committed|merged)\s+(?:(?:the|all|your|these|branch)\s|[a-f\d]{7,40}\b)/i,
  /^(?:当前进度|进度更新|progress update)\s*[:：]/iu,
]

export function isOperationalDialogueText(text: string, role: 'user' | 'assistant'): boolean {
  const opening = text.trimStart().slice(0, 512)
  if (role === 'assistant') return receipts.some((pattern) => pattern.test(opening))
  const action = opening.replace(courtesy, '').replace(branchContext, '').replace(englishCourtesy, '')
  const clause = action.split(/[，。；;\n]/, 1)[0]
  // A question about how an operation works is a substantive discussion.
  if (
    /(?:为什么|为何|原理|怎么设计|如何设计|是什么意思|的区别|有什么区别|有什么风险|的机制|时应该|失败的原因)/u.test(
      clause,
    )
  )
    return false
  return requests.some((pattern) => pattern.test(action))
}
