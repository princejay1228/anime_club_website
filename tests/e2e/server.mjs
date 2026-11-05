// Local end-to-end stack for testing the real pages in a browser:
//   Postgres (real migrations) + PostgREST (the same REST layer Supabase uses)
//   + a tiny stand-in for Supabase Auth + the real /api functions + the static site.
// Google and Resend are faked (no network). Not used in production.
//
//   PGPASSWORD=... POSTGREST_BIN=/path/to/postgrest node tests/e2e/server.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = +(process.env.E2E_PORT || 8787);
const PGRST_PORT = PORT + 1;
const SECRET = 'e2e-only-jwt-secret-0123456789abcdef0123456789';
const DB = 'club_e2e';
const BASE = `http://127.0.0.1:${PORT}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function jwt(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 6 * 3600, iat: Math.floor(Date.now() / 1000), ...claims });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
function verify(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!s || createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(b, 'base64url'));
  return c.exp * 1000 > Date.now() ? c : null;
}
const ANON = jwt({ role: 'anon' });
const SERVICE = jwt({ role: 'service_role' });

// ---------- database ----------
const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', database: 'postgres' });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname='${DB}' and pid<>pg_backend_pid()`);
await admin.query(`drop database if exists ${DB}`);
await admin.query(`create database ${DB}`);
const db = new pg.Client({ host: '127.0.0.1', user: 'postgres', database: DB });
await db.connect();
const shim = readFileSync(path.join(ROOT, 'supabase/tests/supabase_shim.sql'), 'utf8')
  .replace(/create role (\w+) nologin( bypassrls)?;/g, (m, r, b) =>
    `do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin${b || ''}; end if; end $$;`);
await db.query(shim);
for (const f of readdirSync(path.join(ROOT, 'supabase/migrations')).sort()) {
  await db.query(readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8'));
}
await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='authenticator') then
  create role authenticator login noinherit password 'e2e'; end if; end $$;
  grant anon, authenticated, service_role to authenticator;`);

export async function addUser(email, name, { provider = 'google' } = {}) {
  const { rows } = await db.query(`insert into auth.users (email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    values ($1, now(), $2, $3) returning id`, [email, { provider }, { full_name: name, avatar_url: '' }]);
  return rows[0].id;
}

// ---------- PostgREST ----------
const pgrst = spawn(process.env.POSTGREST_BIN || 'postgrest', [], {
  env: { ...process.env, PGRST_DB_URI: `postgres://authenticator:e2e@127.0.0.1/${DB}`, PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET, PGRST_SERVER_PORT: String(PGRST_PORT), PGRST_LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('exit', () => pgrst.kill());
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PGRST_PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

// ---------- fake Google sheet + Resend ----------
export const fakes = { csv: 'ID,Title,Date,Start time,Venue,Description,Category\n', csvStatus: 200, emails: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://docs.google.com/')) {
    return new Response(fakes.csv, { status: fakes.csvStatus, headers: { 'content-type': 'text/csv' } });
  }
  if (u.startsWith('https://api.resend.com/')) { fakes.emails.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
  return realFetch(url, opts);
};
Object.assign(process.env, {
  SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: SERVICE, CRON_SECRET: 'e2e-cron-secret-value',
  EVENTS_CSV_URL: 'https://docs.google.com/spreadsheets/d/e2e/pub?output=csv', RESEND_API_KEY: 're_e2e', SITE_URL: BASE,
});
const sync = (await import(path.join(ROOT, 'api/sync-events.js'))).default;
const notify = (await import(path.join(ROOT, 'api/notify-admin.js'))).default;
const notifyMembers = (await import(path.join(ROOT, 'api/notify-members.js'))).default;

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  try {
    if (url.pathname.startsWith('/rest/v1/')) {
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      if (!headers.authorization && headers.apikey) headers.authorization = 'Bearer ' + headers.apikey;
      const r = await realFetch(`http://127.0.0.1:${PGRST_PORT}${url.pathname.slice(8)}${url.search}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(k))));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url.pathname === '/auth/v1/user') {
      const c = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!c?.sub) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"msg":"invalid JWT"}'); }
      const { rows } = await db.query('select id, email from auth.users where id=$1', [c.sub]);
      res.writeHead(rows[0] ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rows[0] ? { id: rows[0].id, email: rows[0].email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'google' }, user_metadata: {} } : {}));
    }
    if (url.pathname.startsWith('/auth/v1/')) { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/api/')) {
      req.body = body.length ? JSON.parse(body) : {};
      return (url.pathname === '/api/sync-events' ? sync : url.pathname === '/api/notify-members' ? notifyMembers : notify)(req, res);
    }
    if (url.pathname === '/assets/club/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`window.CLUB_CONFIG={supabaseUrl:${JSON.stringify(BASE)},supabaseKey:${JSON.stringify(ANON)}};`);
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    let file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) && existsSync(file + '.html')) file += '.html';
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (e) {
    console.error(e); res.writeHead(500); res.end(String(e));
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// Session object in the shape supabase-js keeps in localStorage.
export async function sessionFor(userId) {
  const { rows } = await db.query('select id, email from auth.users where id=$1', [userId]);
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  return { access_token: jwt({ sub: userId, role: 'authenticated', email: rows[0].email, aud: 'authenticated' }), refresh_token: 'r-' + randomUUID(),
    token_type: 'bearer', expires_in: 6 * 3600, expires_at: exp,
    user: { id: userId, email: rows[0].email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'google' }, user_metadata: {} } };
}
export { db, BASE, server, pgrst, ANON };
console.log('e2e stack on', BASE);
