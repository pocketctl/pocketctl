import process from 'node:process'

import pg from 'pg'
import WebSocket from 'ws'

const enabled = process.env.ALLOW_LOCAL_ATTENTION_E2E === '1'
const baseURL = process.env.RELAY_HTTP_URL || 'http://127.0.0.1:8080'
const wsURL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:8080/ws?type=daemon'
const email = process.env.DEV_EMAIL || 'dev@pocketctl.me'
const emailCode = process.env.DEV_EMAIL_CODE || '888888'
const runID = `${Date.now()}-${process.pid}`
const daemonID = `attention-e2e-daemon-${runID}`
const sessionID = `attention-e2e-session-${runID}`
const requestID = `attention-e2e-request-${runID}`

function assertLocalURL(raw, expectedProtocol) {
  const url = new URL(raw)
  if (url.protocol !== expectedProtocol || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`refusing non-local URL: ${url.origin}`)
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, options)
  let body = null
  try {
    body = await response.json()
  } catch {
    // The caller reports only status/code, never raw response bytes.
  }
  return { response, body }
}

async function accessToken() {
  const headers = { 'content-type': 'application/json' }
  const send = await request('/api/auth/email/send', {
    method: 'POST', headers, body: JSON.stringify({ email, lang: 'zh' }),
  })
  if (!send.response.ok && send.response.status !== 429) {
    throw new Error(`email send failed: HTTP ${send.response.status}`)
  }
  const verify = await request('/api/auth/email/verify', {
    method: 'POST', headers, body: JSON.stringify({ email, code: emailCode, lang: 'zh' }),
  })
  if (!verify.response.ok || typeof verify.body?.access_token !== 'string') {
    throw new Error(`email verify failed: HTTP ${verify.response.status}`)
  }
  return verify.body.access_token
}

function connectDaemon(token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsURL, { headers: { authorization: `Bearer ${token}` } })
    const messages = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      reject(new Error('daemon registration timed out'))
    }, 10_000)

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'register', daemon_id: daemonID, hostname: 'attention-e2e-local',
        agents: ['codex'], agent_versions: { codex: 'e2e' }, os: 'local-e2e', ip: '127.0.0.1',
        arch: 'e2e', version: 'e2e', started_at: Math.floor(Date.now() / 1000),
        acked_seq: 0, active_session_ids: [], supports_quota_grant: true,
      }))
    })
    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      messages.push(message)
      if (message.type === 'register_rejected' && !settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`daemon registration rejected: ${message.reason || 'unknown'}`))
      }
      if (message.type === 'register_ack' && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ socket, messages, registration: message })
      }
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`daemon websocket failed: ${error.message}`))
    })
    socket.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`daemon websocket closed before registration: ${code}`))
    })
  })
}

async function pollItem(token, states, expectedState) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await request(`/api/attention-inbox/v1/items?states=${states}&limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!result.response.ok) throw new Error(`attention snapshot failed: HTTP ${result.response.status}`)
    const item = result.body?.items?.find((candidate) => candidate.request_id === requestID)
    if (item?.state === expectedState) return { item, snapshot: result.body }
    await sleep(200)
  }
  throw new Error(`attention item did not reach ${expectedState}`)
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate()
      resolve()
    }, 1_000)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.close(1000, 'local e2e complete')
  })
}

async function cleanupArtifacts() {
  if (!daemonID.startsWith('attention-e2e-daemon-')
    || !sessionID.startsWith('attention-e2e-session-')
    || !requestID.startsWith('attention-e2e-request-')) {
    throw new Error('refusing cleanup outside the attention e2e namespace')
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for local e2e cleanup')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM attention_items WHERE session_id = $1 AND request_id = $2', [sessionID, requestID])
    await client.query('DELETE FROM event_inbox WHERE session_id = $1 AND daemon_id = $2', [sessionID, daemonID])
    await client.query('DELETE FROM events WHERE session_id = $1', [sessionID])
    await client.query('DELETE FROM sessions WHERE session_id = $1 AND daemon_id = $2', [sessionID, daemonID])
    await client.query('DELETE FROM daemon_ack_checkpoint WHERE daemon_id = $1', [daemonID])
    await client.query('DELETE FROM daemons WHERE daemon_id = $1', [daemonID])
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the cleanup error.
    }
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  if (!enabled) throw new Error('set ALLOW_LOCAL_ATTENTION_E2E=1 to run')
  assertLocalURL(baseURL, 'http:')
  assertLocalURL(wsURL, 'ws:')

  const token = await accessToken()
  const unauthorized = await request('/api/attention-inbox/v1/items')
  if (unauthorized.response.status !== 401) {
    throw new Error(`unauthorized snapshot expected 401, got ${unauthorized.response.status}`)
  }

  let daemon = null
  let report = null
  try {
    daemon = await connectDaemon(token)
    if (daemon.registration.capabilities?.includes('durable_inbox') !== true) {
      throw new Error('Relay did not negotiate durable_inbox')
    }
    daemon.socket.send(JSON.stringify({
      type: 'session_discovered', seq: 1,
      event_id: `attention-e2e-session:${runID}`,
      session_id: sessionID, agent: 'codex', cwd: '/tmp/attention-e2e',
      title: 'Attention Inbox observe E2E', status: 'busy',
      control_mode: 'managed', capabilities: ['terminal_coapproval'],
    }))
    daemon.socket.send(JSON.stringify({
      type: 'approval_request', seq: 2,
      event_id: `attention-e2e-approval:${runID}`,
      session_id: sessionID, request_id: requestID,
      approval_kind: 'commandExecution', tool: 'shell', command: 'true',
      available_decisions: ['accept', 'decline'], risk_level: 'low',
      classification_incomplete: false,
    }))

    const open = await pollItem(token, 'open,snoozed,submitting,result_unknown', 'open')
    const capabilities = open.snapshot?.capabilities
    if (capabilities?.mode !== 'observe' || capabilities?.enabled !== true
      || capabilities?.remote_response_enabled !== false
      || capabilities?.providers?.codex?.projection !== true
      || capabilities?.providers?.codex?.remote_response !== false
      || capabilities?.providers?.['claude-code']?.projection !== false) {
      throw new Error('observe capabilities do not match the rollout contract')
    }

    const action = await request(`/api/attention-inbox/v1/items/${open.item.item_id}/actions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ expected_revision: open.item.revision, action_id: 'once' }),
    })
    if (action.response.status !== 503 || action.body?.error?.code !== 'remote_response_disabled') {
      throw new Error(`observe action expected remote_response_disabled, got HTTP ${action.response.status}`)
    }
    await sleep(250)
    if (daemon.messages.some((message) => message.type === 'approval_response' && message.request_id === requestID)) {
      throw new Error('observe mode unexpectedly sent approval_response to daemon')
    }

    daemon.socket.send(JSON.stringify({
      type: 'approval_resolved', seq: 3,
      event_id: `attention-e2e-resolved:${runID}`,
      session_id: sessionID, request_id: requestID,
      action: 'reject', approved: false, reason: 'terminal',
    }))
    const resolved = await pollItem(token, 'resolved', 'resolved')
    if (resolved.item.resolution?.source !== 'daemon') {
      throw new Error('resolved item did not retain daemon authority')
    }

    report = {
      ok: true,
      mode: capabilities.mode,
      remote_response_enabled: capabilities.remote_response_enabled,
      durable_inbox: true,
      unauthorized_status: unauthorized.response.status,
      action_status: action.response.status,
      action_error: action.body.error.code,
      open_state: open.item.state,
      resolved_state: resolved.item.state,
      resolution_source: resolved.item.resolution.source,
      daemon_id: daemonID,
      session_id: sessionID,
      request_id: requestID,
    }
  } finally {
    if (daemon) await closeSocket(daemon.socket)
    await cleanupArtifacts()
  }
  console.log(JSON.stringify({ ...report, cleanup: 'complete' }))
}

main().catch((error) => {
  console.error(`attention observe e2e failed: ${error.message}`)
  process.exitCode = 1
})
