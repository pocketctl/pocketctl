import type { TeamEvent } from "../types/team";

export function teamSystemEventText(event: TeamEvent): string {
  const text = event.content;
  if (event.kind === "context")
    return `共享 Context 已更新至 v${event.context_version ?? "?"}`;
  if (event.kind !== "run") return text;
  if (
    text.startsWith(
      "You are the coordinator for a bounded PocketCtl Team collaboration run.",
    )
  )
    return "协调 Agent 正在梳理目标与下一步。";
  if (text.startsWith("Automatic collaboration run "))
    return "已发起自动协作，本轮目标与预算已冻结。";
  if (text.startsWith("Coordinator call ended in state "))
    return "协调 Agent 暂时无法继续，协作等待处理。";
  if (text.startsWith("Run stop requested;"))
    return "已请求停止；正在等待已接受的调用完成。";
  if (text.startsWith("Run cancelled after"))
    return "所有已接受的调用已结束，本轮协作已取消。";
  if (text.startsWith("Run is blocked because a call outcome"))
    return "调用结果尚未确认，自动协作不会重复执行。";
  if (text.startsWith("Run stopped because its ") && text.includes("budget"))
    return "本轮协作已达到预算上限。";
  return text;
}
