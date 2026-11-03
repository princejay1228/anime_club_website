// Shared helpers for the Vercel functions. Runs only on the server:
// the service role key never reaches the browser.
import { createClient } from '@supabase/supabase-js';

// SUPABASE_SECRET_KEY is the new "sb_secret_..." key; SUPABASE_SERVICE_ROLE_KEY (legacy JWT) also works.
export const secretKey = (env = process.env) => env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

export function serviceClient(env = process.env) {
  if (!env.SUPABASE_URL || !secretKey(env)) {
    throw new HttpError(500, 'Server is missing SUPABASE_URL or SUPABASE_SECRET_KEY.');
  }
  return createClient(env.SUPABASE_URL, secretKey(env), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Verifies the caller's Supabase session token and returns { user, profile }.
export async function requireUser(sb, req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Please sign in first.');
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  const { data: profile, error: pErr } = await sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (pErr) throw new HttpError(500, 'Could not load your profile.');
  if (!profile) throw new HttpError(403, 'Your profile was not found.');
  return { user: data.user, profile };
}

export async function requireAdmin(sb, req) {
  const who = await requireUser(sb, req);
  if (!(who.profile.is_admin && who.profile.membership_status === 'approved')) {
    throw new HttpError(403, 'Only club admins can do that.');
  }
  return who;
}

// Constant-time string compare for shared secrets.
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Strip anything that looks like a secret before an error is stored or shown.
export function redact(msg, env = process.env) {
  let s = String(msg || 'Unknown error').slice(0, 500);
  for (const k of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_PRIVATE_KEY', 'RESEND_API_KEY', 'CRON_SECRET']) {
    const v = env[k];
    if (v && v.length > 8) s = s.split(v).join('[redacted]');
  }
  return s.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[redacted key]')
          .replace(/\bsb_secret_[\w-]+/g, '[redacted key]')
          .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, '[redacted token]');
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error('[api]', redact(e.stack || e.message));
      send(res, status, { error: status >= 500 && !(e instanceof HttpError) ? 'Something went wrong on the server.' : e.message });
    }
  };
}
