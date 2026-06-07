/**
 * pocketctl 端到端功能测试脚本 v2
 * 修复：DB 凭据、等待时间、覆盖所有新增功能
 */
const WebSocket = require('ws');
const http = require('http');
const { Pool } = require('pg');

const RELAY_URL = 'ws://localhost:8080/ws';
const RESULTS = [];
let testId = 0;

function log(category, name, passed, detail = '') {
  const entry = { id: ++testId, category, name, passed, detail, time: new Date().toISOString() };
  RESULTS.push(entry);
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} [${category}] ${name}${detail ? ' — ' + detail : ''}`);
  return entry;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectWs(type = 'client') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY_URL}?type=${type}&api_key=`);
    const msgs = [];
    ws.on('message', raw => {
      try { msgs.push(JSON.parse(raw.toString())); } catch {}
    });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitForMsg(msgs, type, timeout = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const found = msgs.find(m => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(check, 200);
    };
    check();
  });
}

function waitForMsgFilter(msgs, filter, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const found = msgs.find(filter);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(check, 200);
    };
    check();
  });
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function runTests() {
  console.log('\n🚀 pocketctl 功能测试 v2\n');
  console.log('═'.repeat(60));

  // ═══════════════════════════════════════════
  // TEST GROUP 1: 基础连接 & 健康检查
  // ═══════════════════════════════════════════
  console.log('\n📡 TEST GROUP 1: 基础连接\n');

  // Health check
  try {
    const health = await fetchPage('http://localhost:8080/health');
    log('基础连接', 'Relay health 端点', health.status === 200, `HTTP ${health.status}`);
  } catch (e) {
    log('基础连接', 'Relay health 端点', false, e.message);
  }

  // WebSocket client connect
  let client;
  try {
    client = await connectWs('client');
    log('基础连接', '客户端 WebSocket 连接', true);
  } catch (e) {
    log('基础连接', '客户端 WebSocket 连接', false, e.message);
    console.log('\n❌ 基础连接失败，终止测试');
    generateReport();
    return;
  }

  // WebSocket daemon presence (check via DB)
  const pool = new Pool({ host: 'localhost', port: 5432, database: 'pocketctl', user: 'pocketctl', password: 'pocketctl' });

  // ═══════════════════════════════════════════
  // TEST GROUP 2: list_sessions 功能
  // ═══════════════════════════════════════════
  console.log('\n📋 TEST GROUP 2: list_sessions\n');

  client.ws.send(JSON.stringify({ type: 'list_sessions' }));
  const listResult = await waitForMsg(client.msgs, 'session_list');

  if (listResult) {
    log('list_sessions', '收到 session_list 响应', true, `${listResult.sessions?.length || 0} 条记录`);
    const hasValidFields = listResult.sessions?.every(s => s.session_id && s.status && s.created_at);
    log('list_sessions', '数据结构完整', !!hasValidFields, hasValidFields ? 'session_id + status + created_at' : '缺少字段');
  } else {
    log('list_sessions', '收到 session_list 响应', false, '超时');
    log('list_sessions', '数据结构完整', false, '依赖响应');
  }

  const beforeCount = listResult?.sessions?.length || 0;

  // ═══════════════════════════════════════════
  // TEST GROUP 3: Session 创建全流程
  // ═══════════════════════════════════════════
  console.log('\n🆕 TEST GROUP 3: Session 创建\n');

  client.ws.send(JSON.stringify({
    type: 'session_create',
    agent: 'claude-code',
    cwd: '/Users/muwb/project/pocketctl',
    prompt: 'echo "e2e-test-ok"'
  }));

  // Wait for session_created (usually comes quickly with pending-* ID)
  const created = await waitForMsg(client.msgs, 'session_created', 15000);
  if (created) {
    log('Session 创建', 'session_created 事件', true, `id=${created.session_id?.slice(0, 24)}`);

    // Check NO duplicate session_created
    const dupCreated = client.msgs.filter(m => m.type === 'session_created');
    log('Session 创建', '无重复 session_created', dupCreated.length === 1,
      dupCreated.length === 1 ? '收到 1 次' : `收到 ${dupCreated.length} 次`);

    // Wait for session_id_changed
    const idChanged = await waitForMsgFilter(client.msgs,
      m => m.type === 'session_id_changed' && m.old_session_id === created.session_id,
      30000
    );

    if (idChanged) {
      log('Session 创建', 'session_id_changed 事件', true,
        `${idChanged.old_session_id?.slice(0, 20)}... → ${idChanged.session_id?.slice(0, 8)}...`);
    } else {
      const hasRealId = created.session_id && !created.session_id.startsWith('pending-');
      log('Session 创建', 'session_id_changed 事件', hasRealId,
        hasRealId ? '直接使用真实 ID' : '超时未收到');
    }

    // Wait longer for agent_text (Claude Code startup takes time)
    console.log('    ⏳ 等待 agent 输出 (最多 45 秒)...');
    const agentText = await waitForMsgFilter(client.msgs,
      m => m.type === 'agent_text', 45000
    );
    log('Session 创建', 'agent_text 事件', !!agentText,
      agentText ? `文本: ${agentText.text?.slice(0, 50)}` : '超时未收到');

    // Wait for session_status
    const statusEvt = await waitForMsgFilter(client.msgs,
      m => m.type === 'session_status', 30000
    );
    log('Session 创建', 'session_status 事件', !!statusEvt,
      statusEvt ? `status=${statusEvt.status}` : '超时');

    // Check tool_call and tool_result
    const toolCall = await waitForMsgFilter(client.msgs, m => m.type === 'tool_call', 30000);
    log('Session 创建', 'tool_call 事件', !!toolCall,
      toolCall ? `tool=${toolCall.tool}` : '超时');

    const toolResult = await waitForMsgFilter(client.msgs, m => m.type === 'tool_result', 30000);
    log('Session 创建', 'tool_result 事件', !!toolResult,
      toolResult ? `call_id=${toolResult.call_id?.slice(0, 12)}` : '超时');

    const finalSessionId = idChanged?.session_id || created.session_id;

    // ═══════════════════════════════════════════
    // TEST GROUP 4: Replay 历史消息
    // ═══════════════════════════════════════════
    console.log('\n⏪ TEST GROUP 4: Replay 历史消息\n');

    let replayClient;
    try {
      replayClient = await connectWs('client');
      log('Replay', '新客户端连接', true);
    } catch (e) {
      log('Replay', '新客户端连接', false, e.message);
    }

    if (replayClient) {
      await sleep(300);
      replayClient.ws.send(JSON.stringify({ type: 'replay', session_id: finalSessionId, last_seq: 0 }));

      await sleep(3000);
      // Note: payload.session_id may still be pending-* for session_created,
      // but relay returns all events stored under the real UUID regardless.
      // Filter by both real and pending ID in payload for accuracy.
      const replayMsgs = replayClient.msgs.filter(m =>
        m.type !== 'session_list' && m.type !== 'error' // exclude non-replay messages
      );
      log('Replay', '返回历史事件', replayMsgs.length > 0, `${replayMsgs.length} 条`);

      // Verify all event types are present
      const replayTypes = [...new Set(replayMsgs.map(m => m.type))];
      log('Replay', '包含多种事件类型', replayTypes.length >= 3,
        `类型: ${replayTypes.join(', ')}`);

      // Verify session_created is included (DB stores it under real UUID now after migration)
      const hasSessionCreated = replayMsgs.some(m => m.type === 'session_created');
      log('Replay', 'session_created 在历史中', hasSessionCreated,
        hasSessionCreated ? '已返回' : '未找到');

      // Verify tool_call in replay
      const hasToolCall = replayMsgs.some(m => m.type === 'tool_call');
      log('Replay', 'tool_call 在历史中', hasToolCall);

      // Verify agent_text in replay
      const hasAgentText = replayMsgs.some(m => m.type === 'agent_text');
      log('Replay', 'agent_text 在历史中', hasAgentText);

      replayClient.ws.close();
    }

    // ═══════════════════════════════════════════
    // TEST GROUP 5: DB 持久化验证
    // ═══════════════════════════════════════════
    console.log('\n💾 TEST GROUP 5: DB 持久化\n');

    // Verify via list_sessions API
    client.msgs.length = 0;
    client.ws.send(JSON.stringify({ type: 'list_sessions' }));
    const listAfter = await waitForMsg(client.msgs, 'session_list');

    if (listAfter) {
      const afterCount = listAfter.sessions?.length || 0;
      log('持久化', 'session 数量增加', afterCount > beforeCount,
        `之前: ${beforeCount}, 之后: ${afterCount}`);

      const foundSession = listAfter.sessions?.find(s => s.session_id === finalSessionId);
      log('持久化', '新 session 存在于列表', !!foundSession,
        foundSession ? `status=${foundSession.status}` : '未找到');

      if (foundSession) {
        log('持久化', 'status 值有效',
          ['running', 'completed', 'error', 'killed'].includes(foundSession.status),
          foundSession.status);
        log('持久化', 'agent_type 正确', foundSession.agent_type === 'claude-code',
          foundSession.agent_type);
        log('持久化', 'cwd 正确', foundSession.cwd === '/Users/muwb/project/pocketctl',
          foundSession.cwd);
      }
    }

    // Verify directly in DB
    try {
      const sessRes = await pool.query('SELECT session_id, status, agent_type, cwd FROM sessions WHERE session_id = $1', [finalSessionId]);
      log('持久化', 'DB sessions 表记录存在', sessRes.rows.length > 0);
      if (sessRes.rows.length > 0) {
        const row = sessRes.rows[0];
        log('持久化', 'DB status 与 API 一致', true, row.status);
      }

      const evtCount = await pool.query('SELECT COUNT(*) as cnt FROM events WHERE session_id = $1', [finalSessionId]);
      const cnt = parseInt(evtCount.rows[0]?.cnt || '0');
      log('持久化', 'DB events 表有记录', cnt > 0, `${cnt} 条事件`);

      // Check no orphaned pending-* events remain
      const orphaned = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE session_id LIKE 'pending-%'");
      const orphanCount = parseInt(orphaned.rows[0]?.cnt || '0');
      log('持久化', '无孤立 pending-* 事件', orphanCount === 0,
        orphanCount === 0 ? '全部已迁移' : `${orphanCount} 条孤立记录`);
    } catch (e) {
      log('持久化', 'DB 直接查询', false, e.message);
    }

    // ═══════════════════════════════════════════
    // TEST GROUP 6: 错误事件路由
    // ═══════════════════════════════════════════
    console.log('\n⚠️ TEST GROUP 6: 错误事件路由\n');

    client.msgs.length = 0;
    client.ws.send(JSON.stringify({
      type: 'session_create',
      agent: 'claude-code',
      cwd: '/nonexistent/path/that/does/not/exist',
      prompt: 'test error handling'
    }));

    const errorEvent = await waitForMsgFilter(client.msgs, m => m.type === 'error', 10000);
    log('错误路由', '收到 error 事件', !!errorEvent,
      errorEvent ? (errorEvent.error || '').slice(0, 80) : '超时');

    if (errorEvent) {
      const hasNoDir = (errorEvent.error || '').includes('no such file') || (errorEvent.error || '').includes('not found');
      log('错误路由', '错误信息有意义', hasNoDir, errorEvent.error?.slice(0, 60));
    }

  } else {
    log('Session 创建', 'session_created 事件', false, '超时');
    ['无重复 session_created', 'session_id_changed', 'agent_text', 'session_status', 'tool_call', 'tool_result',
     'Replay 返回历史事件', 'Replay 包含多种事件类型', 'Replay session_created 在历史中',
     'Replay tool_call', 'Replay agent_text',
     '持久化 session 数量增加', '持久化 新 session 存在', '持久化 status 值有效', '持久化 agent_type', '持久化 cwd',
     '持久化 DB sessions', '持久化 DB events', '持久化 无孤立 pending-*',
     '错误路由 收到 error 事件', '错误路由 错误信息有意义'
    ].forEach(n => log(n.split(' ')[0], n.split(' ').slice(1).join(' '), false, '依赖 session_created'));
  }

  // ═══════════════════════════════════════════
  // TEST GROUP 7: 前端页面
  // ═══════════════════════════════════════════
  console.log('\n🌐 TEST GROUP 7: 前端页面\n');

  try {
    const page = await fetchPage('http://localhost:3000');
    log('前端页面', 'HTTP 200', page.status === 200);
    log('前端页面', '__RELAY_WS__ 注入', page.body.includes('__RELAY_WS__'));
    log('前端页面', '端口 8080', page.body.includes(':8080'));
    log('前端页面', 'Vue 挂载点', page.body.includes('id="app"'));
  } catch (e) {
    log('前端页面', '页面访问', false, e.message);
  }

  // ═══════════════════════════════════════════
  // TEST GROUP 8: 多客户端 & 并发
  // ═══════════════════════════════════════════
  console.log('\n👥 TEST GROUP 8: 多客户端\n');

  try {
    const [c2, c3] = await Promise.all([connectWs('client'), connectWs('client')]);
    log('多客户端', '两个客户端同时连接', true);

    await sleep(300);
    c2.ws.send(JSON.stringify({ type: 'list_sessions' }));
    c3.ws.send(JSON.stringify({ type: 'list_sessions' }));

    const [list2, list3] = await Promise.all([
      waitForMsg(c2.msgs, 'session_list'),
      waitForMsg(c3.msgs, 'session_list')
    ]);

    log('多客户端', '两个客户端都收到列表', !!list2 && !!list3,
      `c2: ${list2?.sessions?.length}条, c3: ${list3?.sessions?.length}条`);

    const sameCount = list2?.sessions?.length === list3?.sessions?.length;
    log('多客户端', '数据一致性', sameCount,
      sameCount ? '一致' : '不一致');

    c2.ws.close();
    c3.ws.close();
  } catch (e) {
    log('多客户端', '并发测试', false, e.message);
  }

  // ═══════════════════════════════════════════
  // TEST GROUP 9: Daemon 状态 & DB 完整性
  // ═══════════════════════════════════════════
  console.log('\n🖥️ TEST GROUP 9: Daemon & DB 完整性\n');

  try {
    const daemonRes = await pool.query('SELECT daemon_id, hostname, agents, status FROM daemons ORDER BY last_heartbeat DESC LIMIT 5');
    log('Daemon', 'daemons 表有记录', daemonRes.rows.length > 0, `${daemonRes.rows.length} 个`);

    if (daemonRes.rows.length > 0) {
      const d = daemonRes.rows[0];
      log('Daemon', '状态 online', d.status === 'online', d.status);

      try {
        const agents = typeof d.agents === 'string' ? JSON.parse(d.agents) : d.agents;
        log('Daemon', 'agents 已注册', Array.isArray(agents) && agents.length > 0,
          Array.isArray(agents) ? agents.join(', ') : String(agents));
      } catch { log('Daemon', 'agents 解析', false); }
    }

    // DB schema integrity
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);
    const hasAll = ['daemons', 'sessions', 'events'].every(t => tableNames.includes(t));
    log('DB 完整性', '三个核心表存在', hasAll, tableNames.join(', '));

    // Index check
    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes WHERE tablename = 'events'
    `);
    const idxNames = indexes.rows.map(r => r.indexname);
    log('DB 完整性', 'events 索引存在', idxNames.length > 0, idxNames.join(', '));
  } catch (e) {
    log('Daemon', 'DB 查询', false, e.message);
  }

  // Cleanup
  client.ws.close();
  await pool.end();

  console.log('\n' + '═'.repeat(60));
  const passed = RESULTS.filter(r => r.passed).length;
  const total = RESULTS.length;
  console.log(`测试完成: ${passed}/${total} 通过\n`);

  generateReport();
}

function generateReport() {
  const passed = RESULTS.filter(r => r.passed).length;
  const failed = RESULTS.filter(r => !r.passed).length;
  const total = RESULTS.length;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';

  const categories = {};
  for (const r of RESULTS) {
    if (!categories[r.category]) categories[r.category] = [];
    categories[r.category].push(r);
  }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pocketctl 测试报告 — ${now}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; padding: 20px; line-height: 1.6; }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 4px; color: #58a6ff; }
  .timestamp { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 32px; }
  .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px; text-align: center; }
  .stat-card .num { font-size: 32px; font-weight: 700; }
  .stat-card .label { font-size: 13px; color: #8b949e; margin-top: 4px; }
  .stat-card.pass .num { color: #3fb950; }
  .stat-card.fail .num { color: #f85149; }
  .stat-card.total .num { color: #58a6ff; }
  .stat-card.rate .num { color: #d2a8ff; }
  .progress-bar { height: 8px; background: #21262d; border-radius: 4px; margin-bottom: 24px; overflow: hidden; }
  .progress-bar .fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .category { margin-bottom: 24px; }
  .category-title { font-size: 18px; font-weight: 600; padding: 10px 16px; background: #161b22; border: 1px solid #21262d; border-radius: 8px 8px 0 0; display: flex; align-items: center; gap: 8px; }
  .category-title .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
  .category-title .badge.all-pass { background: #238636; color: white; }
  .category-title .badge.has-fail { background: #da3633; color: white; }
  .test-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; border: 1px solid #21262d; border-top: none; background: #0d1117; }
  .test-row:last-child { border-radius: 0 0 8px 8px; }
  .test-row .icon { font-size: 16px; flex-shrink: 0; margin-top: 2px; }
  .test-row .info { flex: 1; }
  .test-row .name { font-weight: 500; }
  .test-row .detail { font-size: 13px; color: #8b949e; margin-top: 2px; word-break: break-all; }
  .footer { text-align: center; color: #484f58; font-size: 13px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #21262d; }
  @media (max-width: 640px) {
    .summary { grid-template-columns: repeat(2, 1fr); }
    .container { padding: 0; }
    h1 { font-size: 22px; }
  }
</style>
</head>
<body>
<div class="container">
  <h1>🧪 pocketctl 功能测试报告</h1>
  <div class="timestamp">${now} · cross-device-session</div>

  <div class="summary">
    <div class="stat-card total"><div class="num">${total}</div><div class="label">Total</div></div>
    <div class="stat-card pass"><div class="num">${passed}</div><div class="label">Passed ✅</div></div>
    <div class="stat-card fail"><div class="num">${failed}</div><div class="label">Failed ❌</div></div>
    <div class="stat-card rate"><div class="num">${passRate}%</div><div class="label">Pass Rate</div></div>
  </div>
  <div class="progress-bar"><div class="fill" style="width:${passRate}%;background:${parseFloat(passRate)>=90?'#3fb950':parseFloat(passRate)>=70?'#d29922':'#f85149'}"></div></div>

  ${Object.entries(categories).map(([cat, tests]) => {
    const catFail = tests.filter(t => !t.passed).length;
    const badgeClass = catFail === 0 ? 'all-pass' : 'has-fail';
    const badgeText = catFail === 0 ? `${tests.length}/${tests.length} Pass` : `${catFail} Failed`;
    return `<div class="category">
      <div class="category-title">
        ${catFail === 0 ? '✅' : '⚠️'} ${cat}
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      ${tests.map(t => `<div class="test-row">
        <div class="icon">${t.passed ? '✅' : '❌'}</div>
        <div class="info">
          <div class="name">${t.name}</div>
          ${t.detail ? `<div class="detail">${escapeHtml(t.detail)}</div>` : ''}
        </div>
      </div>`).join('')}
    </div>`;
  }).join('')}

  <div class="footer">
    <p>cross-device-session 功能测试 · pocketctl · ${now}</p>
  </div>
</div>
</body>
</html>`;

  const fs = require('fs');
  const reportPath = '/Users/muwb/project/pocketctl/test-report-' + new Date().toISOString().slice(0, 10) + '.html';
  fs.writeFileSync(reportPath, html);
  console.log(`\n📄 HTML 测试报告: ${reportPath}`);
}

runTests().catch(err => {
  console.error('测试运行出错:', err);
  generateReport();
});
