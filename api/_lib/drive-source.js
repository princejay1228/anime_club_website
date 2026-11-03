// Reads the events sheet from Google Drive.
//
// Two ways to connect (set one in Vercel environment variables):
//  1. Private Google Sheet (recommended): share the sheet with a Google
//     service account as Viewer, then set EVENTS_SHEET_ID,
//     GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.
//  2. Published CSV: File > Share > Publish to web > CSV, then set
//     EVENTS_CSV_URL. Anyone with that link can read the sheet.
import { createSign } from 'node:crypto';
import { parseCsv } from './events-normalize.js';

const TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, opts = {}, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Google did not answer in time.' : 'Could not reach Google: ' + e.message);
  } finally {
    clearTimeout(t);
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Service-account access token (OAuth 2.0 JWT bearer flow), no extra libraries.
export async function getGoogleAccessToken(env, fetchImpl = fetch) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Vercel stores the key with literal "\n"; turn them back into newlines.
  const key = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key.includes('PRIVATE KEY')) throw new Error('Google service account is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  let sig;
  try {
    sig = b64url(createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key));
  } catch {
    throw new Error('GOOGLE_PRIVATE_KEY could not be read. Paste the whole private_key value from the JSON key file.');
  }
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
  }, fetchImpl);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google sign-in for the service account failed (${res.status} ${body.error || ''}).`.trim());
  }
  return body.access_token;
}

export function describeSource(env) {
  if (env.EVENTS_SHEET_ID) return 'google-sheet';
  if (env.EVENTS_CSV_URL) return 'published-csv';
  return null;
}

// Returns the sheet as an array of rows (first row = headers).
export async function readEventSheet(env, fetchImpl = fetch) {
  const kind = describeSource(env);
  if (!kind) throw new Error('No events source is configured. Set EVENTS_SHEET_ID (private sheet) or EVENTS_CSV_URL.');

  if (kind === 'google-sheet') {
    const token = await getGoogleAccessToken(env, fetchImpl);
    const range = env.EVENTS_SHEET_RANGE || 'Events';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.EVENTS_SHEET_ID)}/values/${encodeURIComponent(range)}`
      + '?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';
    const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${token}` } }, fetchImpl);
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 404) {
      throw new Error(`Google refused to open the sheet (${res.status}). Check EVENTS_SHEET_ID, the tab name "${range}", and that the sheet is shared with the service account email.`);
    }
    if (!res.ok) throw new Error(`Google Sheets returned an error (${res.status}).`);
    return body.values || [];
  }

  const url = env.EVENTS_CSV_URL;
  if (!/^https:\/\/docs\.google\.com\//.test(url)) throw new Error('EVENTS_CSV_URL must be a docs.google.com published CSV link.');
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, fetchImpl);
  if (!res.ok) throw new Error(`The published CSV could not be downloaded (${res.status}).`);
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (/text\/html/i.test(type) || /^\s*<!doctype html/i.test(text)) {
    throw new Error('The link returned a web page, not CSV. Use File > Share > Publish to web > CSV and copy that link.');
  }
  return parseCsv(text);
}
