// Google Drive helpers for the "Recent meets" gallery. Server only.
//  * Listing uses a Google API key on public ("anyone with the link") folders.
//  * Uploads use the club Google account's authorisation (OAuth, drive.file
//    scope: the site can only touch files and folders it created itself).
//    Its refresh token is stored encrypted with AES-256-GCM.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_GALLERY_FOLDER = '1SbYh3V2DKlD7jmJiPRBp4tkXIoaSGbBj';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------- secrets ----------
export function tokenSecret(env) {
  const s = env.TOKEN_ENC_KEY || env.CRON_SECRET || '';
  return s.length >= 16 ? s : null;
}
const keyFor = (secret, purpose) => createHash('sha256').update(`${purpose}:${secret}`).digest();   // separate keys per use

export function encryptToken(plain, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret, 'drive-token'), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(data)].join('.');
}
export function decryptToken(enc, secret) {
  const [v, iv, tag, data] = String(enc || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Stored Drive token is not readable.');
  const d = createDecipheriv('aes-256-gcm', keyFor(secret, 'drive-token'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// Signed, short-lived "state" for the Google sign-in round trip (proves which admin started it).
export function signState(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + b64u(createHmac('sha256', keyFor(secret, 'oauth-state')).update(body).digest());
}
export function verifyState(state, secret, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', keyFor(secret, 'oauth-state')).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && typeof p.exp === 'number' && p.exp > now ? p : null;
  } catch { return null; }
}

// ---------- listing ----------
export function galleryFolders(env, uploadFolderId) {
  const list = String(env.GALLERY_FOLDER_ID || DEFAULT_GALLERY_FOLDER).split(',').map((s) => s.trim()).filter((s) => ID_RE.test(s));
  if (uploadFolderId && ID_RE.test(uploadFolderId) && !list.includes(uploadFolderId)) list.push(uploadFolderId);
  return list;
}

// EXIF style "2026:11:04 18:20:05" -> ISO (India time)
function exifTime(t) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(t || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30` : null;
}

export function toGalleryItem(f, folderId) {
  const mime = String(f.mimeType || '');
  const kind = mime.startsWith('image/') ? 'photo' : mime.startsWith('video/') ? 'video' : null;
  if (!kind || !ID_RE.test(f.id || '')) return null;
  const meta = kind === 'photo' ? f.imageMediaMetadata || {} : f.videoMediaMetadata || {};
  const rotated = kind === 'photo' && (meta.rotation === 1 || meta.rotation === 3);
  return {
    drive_id: f.id, folder_id: folderId, name: String(f.name || '').slice(0, 300), kind, mime_type: mime.slice(0, 100),
    width: (rotated ? meta.height : meta.width) || null, height: (rotated ? meta.width : meta.height) || null,
    sort_time: exifTime(meta.time) || f.createdTime || null,
  };
}

export async function listFolder(folderId, apiKey, fetchImpl = fetch) {
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const q = `'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`;
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('q', q);
    u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,createdTime,imageMediaMetadata(width,height,rotation,time),videoMediaMetadata(width,height))');
    u.searchParams.set('pageSize', '200');
    u.searchParams.set('orderBy', 'createdTime desc');
    u.searchParams.set('supportsAllDrives', 'true');
    u.searchParams.set('includeItemsFromAllDrives', 'true');
    u.searchParams.set('key', apiKey);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const res = await fetchImpl(u.toString());
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `Google Drive answered ${res.status}`;
      throw new Error(res.status === 404 ? `Folder ${folderId} was not found or is not shared as "Anyone with the link".` : msg);
    }
    for (const f of body.files || []) { const it = toGalleryItem(f, folderId); if (it) items.push(it); }
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return items;
}

export async function runGallerySync({ sb, env, fetchImpl = fetch }) {
  if (!env.GOOGLE_API_KEY) return { ok: false, error: 'GOOGLE_API_KEY is not set in Vercel, so the gallery cannot read Drive yet.' };
  const { data: conn } = await sb.from('drive_connection').select('upload_folder_id').eq('id', 1).maybeSingle();
  const folders = galleryFolders(env, conn?.upload_folder_id);
  const items = [];
  for (const f of folders) items.push(...await listFolder(f, env.GOOGLE_API_KEY, fetchImpl));
  const { data, error } = await sb.rpc('apply_gallery_sync', { p_items: items, p_folders: folders });
  if (error) throw new Error('Could not save the gallery list: ' + error.message);
  return { ok: true, folders: folders.length, ...data };
}

// ---------- OAuth (club Google account, for uploads) ----------
export const redirectUri = (env) => `${(env.SITE_URL || 'https://simats-anime-club.vercel.app').replace(/\/+$/, '')}/api/gallery`;
export const uploadsConfigured = (env) => !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && tokenSecret(env));

export function consentUrl(env, state) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(env));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', DRIVE_SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');                 // always returns a refresh token
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('login_hint', env.ADMIN_EMAIL || 'animeclubsimats@gmail.com');
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenCall(params, fetchImpl) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error === 'invalid_grant'
      ? 'Google no longer accepts the saved Drive connection. Connect Google Drive again in the admin Gallery tab.'
      : `Google sign-in failed (${body.error || res.status}).`);
    e.code = body.error; throw e;
  }
  return body;
}
export const exchangeCode = (env, code, fetchImpl = fetch) => tokenCall({
  code, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirect_uri: redirectUri(env), grant_type: 'authorization_code' }, fetchImpl);
export const refreshAccess = (env, refreshToken, fetchImpl = fetch) => tokenCall({
  refresh_token: refreshToken, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  grant_type: 'refresh_token' }, fetchImpl);

async function driveCall(accessToken, url, opts = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { ...opts, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Google Drive answered ${res.status}`);
  return body;
}

// The site's own upload folder in the club Drive, shared "anyone with the link can view"
// so the gallery can list it and show its files.
export async function ensureUploadFolder(accessToken, existingId, fetchImpl = fetch) {
  if (existingId && ID_RE.test(existingId)) {
    try {
      const f = await driveCall(accessToken, `https://www.googleapis.com/drive/v3/files/${existingId}?fields=id,trashed`, {}, fetchImpl);
      if (f.id && !f.trashed) return f.id;
    } catch { /* not usable any more: make a new one */ }
  }
  const folder = await driveCall(accessToken, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', body: JSON.stringify({ name: 'SIMATS Anime Club — website uploads', mimeType: 'application/vnd.google-apps.folder' }) }, fetchImpl);
  await driveCall(accessToken, `https://www.googleapis.com/drive/v3/files/${folder.id}/permissions?fields=id`, {
    method: 'POST', body: JSON.stringify({ role: 'reader', type: 'anyone' }) }, fetchImpl);
  return folder.id;
}

export async function accountEmail(accessToken, fetchImpl = fetch) {
  try {
    const a = await driveCall(accessToken, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {}, fetchImpl);
    return a?.user?.emailAddress || null;
  } catch { return null; }
}
