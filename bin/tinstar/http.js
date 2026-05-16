// bin/tinstar/http.js
import http from 'node:http'
import https from 'node:https'

export function httpJson(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl)
    const lib = u.protocol === 'https:' ? https : http
    const body = opts.body ? JSON.stringify(opts.body) : null
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 5000,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (!data) return resolve({})
        const trimmed = data.trimStart()
        if (trimmed.startsWith('<')) {
          reject(new Error(`got HTML from ${rawUrl} (status ${res.statusCode}) — another process is listening on this port`))
          return
        }
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`bad json from ${rawUrl}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error(`timeout calling ${rawUrl}`)) })
    if (body) req.write(body)
    req.end()
  })
}
