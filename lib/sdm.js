import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

export function readCredentials(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  try { const j = JSON.parse(raw); if (j.userName && j.password) return j; } catch {}
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  const values = {};
  for (const line of lines) {
    const m = line.match(/^(user(?:name)?|password|pwd)\s*[:=\s]\s*(.+)$/i);
    if (m) values[/^user/i.test(m[1]) ? 'userName' : 'password'] = m[2];
  }
  if (values.userName && values.password) return values;
  if (lines.length === 2) return { userName: lines[0], password: lines[1] };
  throw new Error('Credential file must contain JSON {userName,password}, labelled values, or username and password on separate lines.');
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/((?:JSESSIONID|sessionId|password|authorization)\s*[=:]\s*)[^\s;,<]+/gi, '$1[redacted]');
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
    return result;
  }
  if (Array.isArray(value)) return value.map(x => redact(x, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|sessionid|cookie|authorization|token/i.test(k) ? '[redacted]' : redact(v, secrets)]));
  return value;
}

export class SdmClient {
  constructor({ baseUrl, credentials, verifyTls = true, ca, onLog = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.credentials = credentials;
    this.verifyTls = verifyTls; this.ca = ca; this.onLog = onLog; this.cookie = '';
  }
  async request(method, route, body) {
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('..')) throw new Error('Invalid SDM path');
    const url = new URL(this.baseUrl + route); const start = Date.now();
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (this.cookie) headers.Cookie = this.cookie;
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const secrets = [this.credentials?.password, this.cookie, this.cookie?.split('=')[1]];
    try {
      const result = await new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers, rejectUnauthorized: this.verifyTls, ca: this.ca }, res => {
          let raw = ''; res.setEncoding('utf8');
          res.on('data', chunk => { raw += chunk; if (raw.length > 16 * 1024 * 1024) req.destroy(new Error('SDM response exceeds 16 MB')); });
          res.on('error', reject);
          res.on('end', () => { let parsed = raw; try { parsed = raw ? JSON.parse(raw) : null; } catch {} resolve({ status: res.statusCode, body: parsed, headers: res.headers }); });
        });
        req.setTimeout(60000, () => req.destroy(new Error('SDM request timed out')));
        req.on('error', reject); req.end(data);
      });
      if (route === '/admin/login' && result.status < 300) {
        const cookies = result.headers['set-cookie'] || [];
        this.cookie = cookies.map(c => c.split(';')[0]).join('; ') || (result.body?.sessionId ? `JSESSIONID=${result.body.sessionId}` : '');
        secrets.push(result.body?.sessionId);
      }
      this.onLog(redact({ method, url: url.href, request: body, status: result.status, response: result.body, durationMs: Date.now()-start, time: new Date().toISOString() }, secrets));
      if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`SDM ${method} ${route.split('?')[0]} returned HTTP ${result.status}`), { status: result.status,details:{method,url:url.href,status:result.status,request:body,response:result.body} });
      return result.body;
    } catch (error) {
      if (!error.status) this.onLog(redact({ method, url: url.href, request: body, status: 'ERROR', response: error.message, durationMs: Date.now()-start, time: new Date().toISOString() }, secrets));
      throw error;
    }
  }
  async login() { return this.request('POST', '/admin/login', this.credentials); }
  async list(route, key) {
    const all = []; let offset = 1; let previous;
    for (let page = 0; page < 2000; page++) {
      const body = await this.request('GET', `${route}${route.includes('?') ? '&' : '?'}limitation=50&offset=${offset}`);
      const rows = body?.[key] || []; if (!Array.isArray(rows)) throw new Error(`Unexpected SDM list response: ${key}`);
      const signature = JSON.stringify(rows);
      if (rows.length && signature === previous) throw new Error('SDM repeated a page; search stopped to avoid incomplete results.');
      all.push(...rows); previous = signature;
      const size = Number(body?.pageInfo?.limitation || 50);
      if (!rows.length || rows.length < size || !body.pageInfo) return all;
      offset += rows.length;
    }
    throw new Error('SDM page limit reached; search results would be incomplete.');
  }
}
