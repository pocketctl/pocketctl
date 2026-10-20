import MarkdownIt from 'markdown-it';
import { projectShareEvents, readable, type ShareEvent, type ShareItem } from './model.js';
import { shareStyles } from './styles.js';

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
// A public share must not fetch remote images or resolve relative links against its bearer URL.
md.validateLink = href => /^https?:\/\//i.test(href);
md.renderer.rules.image = (tokens, index) => `<span class="image-placeholder">[图片：${escapeHtml(tokens[index].content || '未加载')}]</span>`;
md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('rel', 'noreferrer noopener');
  tokens[index].attrSet('target', '_blank');
  return renderer.renderToken(tokens, index, options);
};
md.renderer.rules.table_open = () => '<div class="table-wrap" tabindex="0" role="region" aria-label="表格，可横向滚动"><table>';
md.renderer.rules.table_close = () => '</table></div>';
const safe = escapeHtml;
function time(value: string | Date | undefined, full = false): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  // Public HTML has no client script: state the timezone instead of implying local time.
  return date.toISOString().slice(full ? 0 : 11, 16).replace('T', ' ') + ' UTC';
}
function meta(row: ShareItem): string {
  return `<div class="message-meta"><strong>${safe(row.label)}</strong><time>${safe(time(row.time))}</time></div>`;
}
function recordDetails(records: ShareEvent[]): string {
  return `<details class="raw"><summary>查看原始记录（${records.length}）</summary><pre>${safe(readable(records))}</pre></details>`;
}
function renderItem(row: ShareItem): string {
  if (row.kind === 'user') return `<article class="user-message">${meta(row)}<div class="user-text">${safe(row.text)}</div></article>`;
  if (row.kind === 'agent') return `<article class="agent-message">${meta(row)}<div class="prose">${md.render(row.text)}</div>${row.incomplete ? '<p class="incomplete">本次读取的回复尚不完整；已保留可确认的内容。</p>' : ''}</article>`;
  if (row.kind === 'notice') return `<aside class="warning">${meta(row)}<p>${safe(row.text)}</p></aside>`;
  if (row.kind === 'tool') return `<details class="step"><summary><strong>${safe(row.label)}</strong><span class="tool-status${row.failed ? ' failed' : ''}">${safe(row.status || '')}</span></summary><p class="tool-owner">${safe(row.actor)}</p>${row.input !== undefined ? `<h3>输入</h3><pre>${safe(readable(row.input))}</pre>` : '<p class="subtle">未收到对应的调用输入。</p>'}${row.output !== undefined ? `<h3>输出</h3><pre>${safe(row.output)}</pre>` : '<p class="subtle">未收到对应的结果。</p>'}${row.incomplete ? '<p class="incomplete">输出记录尚不完整，可展开原始记录核对。</p>' : ''}</details>`;
  return `<details class="step"><summary>${safe(row.label)} <span class="tool-owner">${safe(row.actor)}</span></summary><pre>${safe(row.text)}</pre></details>`;
}
function renderItems(items: ShareItem[]): string {
  const result: string[] = [];
  for (let index = 0; index < items.length;) {
    if (items[index].kind !== 'tool' && items[index].kind !== 'detail') { result.push(renderItem(items[index++])); continue; }
    const group: ShareItem[] = [];
    while (index < items.length && (items[index].kind === 'tool' || items[index].kind === 'detail')) group.push(items[index++]);
    const tools = group.filter(row => row.kind === 'tool');
    const failed = tools.some(row => row.failed);
    const count = tools.length;
    const title = count ? `${count} 项工具操作${group.length > count ? ` · ${group.length - count} 条其他记录` : ''}` : `${group.length} 条过程记录`;
    result.push(`<details class="process"><summary><span class="process-title">${title}</span><span class="process-status${failed ? ' failed' : ''}">${failed ? '包含失败记录' : '展开查看'}</span></summary><div class="process-body">${group.map(renderItem).join('')}</div></details>`);
  }
  return result.join('\n');
}
function document(body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>共享会话 · PocketCtl</title><style>${shareStyles}</style></head><body class="app"><div class="viewport"><header class="site-header"><a class="brand" href="#top">pocketctl</a><div class="header-actions"><span class="readonly">只读分享</span><details class="appearance"><summary>外观</summary><fieldset><legend>页面主题</legend><label><input type="radio" name="theme" id="theme-auto" checked>跟随系统</label><label><input type="radio" name="theme" id="theme-light">浅色</label><label><input type="radio" name="theme" id="theme-dark">深色</label></fieldset></details></div></header><main id="top">${body}</main><footer class="site-footer">通过 PocketCtl 分享 <span>·</span> 只读会话</footer></div></body></html>`;
}
export function unavailablePage(): string {
  return document('<section class="empty-state"><h1>分享链接不可用</h1><p>链接可能已过期、被修改，或对应会话已不可访问。</p><p class="subtle">请联系分享者获取新的链接。</p></section>');
}
export function shareViewerPage(events: ShareEvent[], options: { readAt?: Date; expiresAt?: Date } = {}): string {
  const turns = projectShareEvents(events);
  const readAt = options.readAt ?? new Date();
  const userTurns = turns.filter(turn => turn.items.some(item => item.kind === 'user'));
  return document(`<section class="intro"><div class="eyebrow">共享会话</div><h1>共享会话</h1><p class="description">按对话顺序阅读，执行过程可展开查看。</p><div class="metadata"><span>${userTurns.length} 轮提问</span><span>读取于 ${safe(time(readAt, true))}</span></div><div class="expiry"><span class="dot"></span>临时链接${options.expiresAt ? ` · ${safe(time(options.expiresAt, true))} 到期` : ''}<span class="expiry-note">内容截至本次打开时</span></div></section>${turns.length ? `<nav class="reading-nav" aria-label="阅读导航"><span>会话内容</span><div><span class="subtle">执行过程按需展开</span><a href="#${turns.at(-1)!.id}">跳至最后一段 ↓</a></div></nav>${turns.map((turn, index) => `<section class="turn" id="${turn.id}" aria-label="第 ${index + 1} 段会话"><div class="turn-marker"><span>${String(index + 1).padStart(2, '0')}</span>${turn.items.some(item => item.kind === 'user') ? '对话' : '会话记录'}</div>${renderItems(turn.items)}${recordDetails(turn.records)}</section>`).join('')}<footer class="end"><span>已读至本次记录末尾</span><a href="#top">回到顶部 ↑</a></footer>` : '<section class="empty-state"><h2>暂无可显示的会话内容</h2><p>本次打开时没有可供阅读的消息。</p></section>'}`);
}
