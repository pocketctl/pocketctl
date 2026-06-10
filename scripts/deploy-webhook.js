/**
 * pocketctl 部署 Webhook 服务
 * 监听 Gitee push 事件，自动拉取代码并重启服务
 *
 * 端口: 9000
 * 路径: POST /webhook/deploy
 */

const http = require('http');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
const fs = require('fs');

const PORT = 9000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'pocketctl-deploy-secret-2026';
const REPO_DIR = '/opt/pocketctl';
const LOG_FILE = '/var/log/pocketctl-deploy.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function deploy(branch) {
  log(`开始部署分支: ${branch}`);

  try {
    // 1. 拉取最新代码
    log('git pull...');
    execSync(`cd ${REPO_DIR} && git pull origin ${branch}`, { encoding: 'utf8', timeout: 30000 });

    // 2. 构建 Relay
    log('npm ci + build...');
    execSync(`cd ${REPO_DIR}/relay && npm ci 2>/dev/null && npm run build && npm prune --production 2>/dev/null`, { encoding: 'utf8', timeout: 120000 });

    // 3. 构建 Go Daemon
    log('go build daemon...');
    try {
      execSync(`which go && cd ${REPO_DIR} && go build -o /usr/local/bin/pocketctl ./cmd/pocketctl/`, { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      log('Go 未安装，跳过 daemon 构建');
    }

    // 4. 重启 Relay 服务
    log('restart relay...');
    execSync('systemctl restart pocketctl-relay', { encoding: 'utf8', timeout: 10000 });

    // 5. 验证
    setTimeout(() => {
      try {
        const health = execSync('curl -s http://localhost/health', { encoding: 'utf8', timeout: 5000 });
        log(`部署完成，健康检查: ${health.trim()}`);
      } catch (e) {
        log(`部署完成，但健康检查失败: ${e.message}`);
      }
    }, 3000);

    return { success: true, message: `分支 ${branch} 部署成功` };
  } catch (e) {
    log(`部署失败: ${e.message}`);
    // 尝试回滚
    try {
      log('尝试回滚到上一个 commit...');
      execSync(`cd ${REPO_DIR} && git reset --hard HEAD~1`, { encoding: 'utf8' });
      execSync(`cd ${REPO_DIR}/relay && npm run build`, { encoding: 'utf8', timeout: 60000 });
      execSync('systemctl restart pocketctl-relay', { encoding: 'utf8' });
      log('回滚成功');
    } catch (rollbackErr) {
      log(`回滚也失败了: ${rollbackErr.message}`);
    }
    return { success: false, message: e.message };
  }
}

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'deploy-webhook' }));
    return;
  }

  // 手动触发部署
  if (req.method === 'POST' && req.url === '/deploy') {
    log('手动触发部署');
    const result = deploy('master');
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Gitee Webhook (支持 GET 测试)
  if (req.url === '/webhook/deploy') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: 'Webhook endpoint ready. Use POST to trigger deploy.' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // 验证签名（Gitee 用的是 X-Gitee-Token 或 HMAC）
      const signature = req.headers['x-gitee-signature'] || req.headers['x-hub-signature-256'];

      // 如果配置了 secret，验证签名
      if (WEBHOOK_SECRET && signature) {
        if (!verifySignature(body, signature)) {
          log('签名验证失败');
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid signature' }));
          return;
        }
      }

      try {
        const event = JSON.parse(body);
        const branch = (event.ref || '').replace('refs/heads/', '');
        const pusher = event.user_name || event.sender?.login || 'unknown';
        const commits = event.commits || [];

        log(`收到 push 事件: ${pusher} 推送到 ${branch}, ${commits.length} 个 commit`);

        // 只处理 master 分支的 push
        if (branch === 'master' || branch === 'main') {
          const result = deploy(branch);
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          log(`忽略非 master 分支: ${branch}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ skipped: true, message: `忽略分支 ${branch}` }));
        }
      } catch (e) {
        log(`解析 webhook 失败: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`部署 Webhook 服务启动，监听端口 ${PORT}`);
  log(`  Gitee Webhook: POST http://39.106.218.47:${PORT}/webhook/deploy`);
  log(`  手动部署:      POST http://39.106.218.47:${PORT}/deploy`);
  log(`  健康检查:      GET  http://39.106.218.47:${PORT}/health`);
});
