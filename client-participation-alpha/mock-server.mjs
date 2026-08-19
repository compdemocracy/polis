// Temporary local mock of the Polis server API, for testing the Phase 1/2 UI
// changes end-to-end (18-statement voting flow + completion modal) without a
// real backend. NOT part of the shipped app — do not deploy this file.
//
// Usage: node mock-server.mjs   (listens on http://localhost:5050)

import { createServer } from 'node:http'

const PORT = 5050

const STATEMENTS = Array.from({ length: 18 }, (_, i) => ({
  tid: i + 1,
  txt: `[테스트 문항 ${i + 1}] 사이버 보안 관련 가상의 의견 문장입니다. 실제 데이터가 아닙니다.`,
  lang: 'ko'
}))

// Single global pointer — fine for manual, single-user local testing.
let cursor = 0

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function sendJson(res, status, body) {
  withCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function currentNextComment() {
  if (cursor >= STATEMENTS.length) return undefined
  const st = STATEMENTS[cursor]
  return { ...st, remaining: STATEMENTS.length - cursor - 1 }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  console.log(req.method, url.pathname)

  if (req.method === 'OPTIONS') {
    withCors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/participationInit') {
    sendJson(res, 200, {
      conversation: {
        topic: '사이버 보안 (테스트 대화방)',
        description: '가상 백엔드로 실행 중인 로컬 테스트용 대화방입니다.',
        treevite_enabled: false,
        is_active: true,
        conversation_id: url.searchParams.get('conversation_id') || 'test',
        vis_type: 0,
        topics_enabled: false,
        importance_enabled: false
      },
      nextComment: currentNextComment()
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/nextComment') {
    sendJson(res, 200, currentNextComment() || {})
    return
  }

  if (req.method === 'GET' && url.pathname === '/comments') {
    sendJson(res, 200, [])
    return
  }

  if (req.method === 'POST' && url.pathname === '/votes') {
    await readBody(req)
    cursor += 1
    const nextComment = currentNextComment()
    sendJson(res, 200, nextComment ? { nextComment } : {})
    return
  }

  if (req.method === 'POST' && url.pathname === '/comments') {
    await readBody(req)
    sendJson(res, 200, { status: 'ok' })
    return
  }

  if (req.method === 'POST' && url.pathname === '/notifications') {
    await readBody(req)
    sendJson(res, 200, { status: 'ok' })
    return
  }

  sendJson(res, 404, { error: `no mock handler for ${req.method} ${url.pathname}` })
})

server.listen(PORT, () => {
  console.log(`Mock Polis API listening on http://localhost:${PORT}`)
  console.log(`${STATEMENTS.length} fake statements loaded. Vote through all of them to trigger the completion modal.`)
})
