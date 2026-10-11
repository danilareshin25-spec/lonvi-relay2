// LonviSound relay — сервер-посредник для пользователей из России.
// Приложение обращается к нему, а он — к SoundCloud (и к базе текстов песен).
// Без зависимостей, нужен Node.js 18+. Запуск: LONVI_KEY=секрет node server.mjs
import http from 'node:http'
import { Readable } from 'node:stream'

const PORT = Number(process.env.PORT || 8787)
const KEY = process.env.LONVI_KEY || ''
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
// только эти сервера — чтобы посредник не превратился в открытый прокси
const ALLOW = /(^|\.)(soundcloud\.com|sndcdn\.com|soundcloud\.cloud|lrclib\.net)$/

if (!KEY) {
  console.error('Задайте секретный ключ: LONVI_KEY=... node server.mjs')
  process.exit(1)
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
}

function relayLink(req, url) {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${req.headers.host}/r?k=${encodeURIComponent(KEY)}&u=${encodeURIComponent(url)}`
}

// В HLS-плейлисте адреса кусков абсолютные — заворачиваем и их через посредника
function rewritePlaylist(req, text, base) {
  const abs = (u) => new URL(u, base).toString()
  return text
    .split('\n')
    .map((line) => {
      const l = line.trim()
      if (!l) return line
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${relayLink(req, abs(u))}"`)
      return relayLink(req, abs(l))
    })
    .join('\n')
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
    if (u.pathname === '/health') return res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' }).end('ok')
    if (u.pathname !== '/r') return res.writeHead(404, cors).end()
    if (u.searchParams.get('k') !== KEY) return res.writeHead(403, cors).end('bad key')

    const target = new URL(u.searchParams.get('u') || '')
    if (target.protocol !== 'https:' || !ALLOW.test(target.hostname)) return res.writeHead(400, cors).end('host not allowed')

    // без сжатия: тогда длина ответа и диапазоны (перемотка) передаются как есть
    const headers = { 'User-Agent': UA, Accept: req.headers.accept || '*/*', 'Accept-Encoding': 'identity' }
    if (req.headers.range) headers.Range = req.headers.range
    if (/soundcloud/.test(target.hostname)) Object.assign(headers, { Origin: 'https://soundcloud.com', Referer: 'https://soundcloud.com/' })

    const r = await fetch(target, { headers, redirect: 'follow' })
    const type = r.headers.get('content-type') || ''
    if (/mpegurl/i.test(type) || target.pathname.endsWith('.m3u8')) {
      const body = rewritePlaylist(req, await r.text(), r.url)
      return res.writeHead(r.status, { ...cors, 'Content-Type': type || 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).end(body)
    }
    const out = { ...cors, 'Content-Type': type || 'application/octet-stream' }
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const v = r.headers.get(h)
      if (v) out[h] = v
    }
    res.writeHead(r.status, out)
    if (!r.body) return res.end()
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res)
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, cors)
    res.end(String(e?.message || e))
  }
})

server.listen(PORT, () => console.log(`LonviSound relay: http://0.0.0.0:${PORT}`))
