// Tiny HTTP server that echoes request headers as HTML
import { createServer } from 'node:http'

const PORT = 9876

createServer((req, res) => {
  const rows = Object.entries(req.headers)
    .map(([k, v]) => `<tr><td style="font-weight:bold;padding:4px 12px 4px 0">${k}</td><td style="padding:4px 0">${v}</td></tr>`)
    .join('\n')

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<!DOCTYPE html>
<html><head><title>Header Echo</title>
<style>body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:24px}
table{border-collapse:collapse}tr:nth-child(odd){background:#16213e}
td{padding:6px 12px}h1{color:#0ff;margin-bottom:16px}</style></head>
<body><h1>Request Headers</h1><table>${rows}</table></body></html>`)
}).listen(PORT, () => console.log(`Header echo server at http://localhost:${PORT}`))
