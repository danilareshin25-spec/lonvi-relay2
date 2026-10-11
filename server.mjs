// LonviSound relay — сервер-посредник для пользователей из России.
// Приложение обращается к нему, а он — к SoundCloud (и к базе текстов песен).
// Без зависимостей, нужен Node.js 18+. Запуск: LONVI_KEY=секрет node server.mjs
import http from 'node:http'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'

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

// Учёт: сколько отдано и кто заходил (последние запросы — без полных IP)
const stats = { since: new Date().toISOString(), requests: 0, bytes: 0, byHost: {}, recent: [] }
const count = (req, host, status, bytes) => {
  stats.requests++
  stats.bytes += bytes
  stats.byHost[host] = (stats.byHost[host] || 0) + bytes
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const country = req.headers['cf-ipcountry'] || req.headers['x-country'] || ''
  stats.recent.unshift({ t: new Date().toISOString(), ip: ip.split(/[.:]/).slice(0, 2).join('.') + '.*', country, host, status, bytes })
  stats.recent.length = Math.min(stats.recent.length, 60)
}
// Сообщения от приложения (что у пользователя работает, а что нет)
const reports = []

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
    if (u.pathname === '/health') return res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' }).end('ok')
    if (u.pathname === '/stats') {
      if (u.searchParams.get('k') !== KEY) return res.writeHead(403, cors).end('bad key')
      return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ...stats, reports }, null, 1))
    }
    if (u.pathname === '/report') {
      if (u.searchParams.get('k') !== KEY) return res.writeHead(403, cors).end('bad key')
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
      reports.unshift({ t: new Date().toISOString(), ip: ip.split(/[.:]/).slice(0, 2).join('.') + '.*', m: String(u.searchParams.get('m') || '').slice(0, 600) })
      reports.length = Math.min(reports.length, 40)
      return res.writeHead(204, cors).end()
    }
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
      return sendText(req, res, r.status, { ...cors, 'Content-Type': type || 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }, body, target.hostname)
    }
    // JSON, страницы, тексты песен — сжимаем (в 5–10 раз меньше трафика)
    if (/json|text|javascript|xml/i.test(type) && !req.headers.range) {
      return sendText(req, res, r.status, { ...cors, 'Content-Type': type }, Buffer.from(await r.arrayBuffer()), target.hostname)
    }
    const out = { ...cors, 'Content-Type': type || 'application/octet-stream' }
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const v = r.headers.get(h)
      if (v) out[h] = v
    }
    res.writeHead(r.status, out)
    if (!r.body) return res.end()
    let sent = 0
    const stream = Readable.fromWeb(r.body)
    stream.on('data', (c) => (sent += c.length))
    stream.on('end', () => count(req, target.hostname, r.status, sent))
    stream.on('error', () => res.destroy()).pipe(res)
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, cors)
    res.end(String(e?.message || e))
  }
})

function sendText(req, res, status, headers, body, host) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (/gzip/.test(req.headers['accept-encoding'] || '') && buf.length > 1024) {
    const z = zlib.gzipSync(buf, { level: 6 })
    count(req, host, status, z.length)
    return res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': z.length, Vary: 'Accept-Encoding' }).end(z)
  }
  count(req, host, status, buf.length)
  return res.writeHead(status, { ...headers, 'Content-Length': buf.length }).end(buf)
}

server.listen(PORT, () => console.log(`LonviSound relay: http://0.0.0.0:${PORT}`))
