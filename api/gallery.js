// /api/gallery
//   POST { action }  (admin session required)
//     status       what is set up: listing (API key), uploads (OAuth), connection
//     sync         re-read the Drive folder(s) into the gallery list
//     connect-url  Google sign-in link for the club account (one time, for uploads)
//     upload-token short-lived Drive access token so the admin's browser uploads
//                  files straight to Google (the files never pass through Vercel)
//     disconnect   forget the Drive connection
//   GET ?code&state  Google sends the admin back here after the one-time sign-in.
import { serviceClient, requireAdmin, redact, send, wrap, HttpError } from './_lib/server.js';
import {
  runGallerySync, galleryFolders, uploadsConfigured, tokenSecret, consentUrl, signState, verifyState, exchangeCode,
  refreshAccess, encryptToken, decryptToken, ensureUploadFolder, accountEmail,
} from './_lib/google-drive.js';

const back = (res, query) => { res.statusCode = 302; res.setHeader('location', `/admin?${query}#gallery`); res.setHeader('cache-control', 'no-store'); res.end(); };

export async function handleCallback({ sb, env, query, fetchImpl = fetch }) {
  if (query.error) return `drive=error&msg=${encodeURIComponent(query.error === 'access_denied' ? 'Google sign-in was cancelled.' : query.error)}`;
  const secret = tokenSecret(env);
  if (!uploadsConfigured(env) || !secret) return 'drive=error&msg=' + encodeURIComponent('Drive uploads are not set up in Vercel yet.');
  const st = verifyState(query.state, secret);
  if (!st?.uid) return 'drive=error&msg=' + encodeURIComponent('That sign-in link expired. Please press Connect Google Drive again.');
  const { data: admin } = await sb.from('profiles').select('id,is_admin,membership_status').eq('id', st.uid).maybeSingle();
  if (!admin?.is_admin || admin.membership_status !== 'approved') return 'drive=error&msg=' + encodeURIComponent('Only club admins can connect Drive.');
  if (!query.code) return 'drive=error&msg=' + encodeURIComponent('Google did not send a sign-in code.');

  const tok = await exchangeCode(env, query.code, fetchImpl);
  if (!tok.refresh_token) return 'drive=error&msg=' + encodeURIComponent('Google did not give a lasting permission. Remove the app under myaccount.google.com/permissions and connect again.');
  const { data: old } = await sb.from('drive_connection').select('upload_folder_id').eq('id', 1).maybeSingle();
  const folderId = await ensureUploadFolder(tok.access_token, old?.upload_folder_id, fetchImpl);
  const email = await accountEmail(tok.access_token, fetchImpl);
  const { error } = await sb.from('drive_connection').upsert({
    id: 1, refresh_token_enc: encryptToken(tok.refresh_token, secret), account_email: email, upload_folder_id: folderId,
    connected_by: st.uid, connected_at: new Date().toISOString() });
  if (error) throw new Error('Could not save the Drive connection.');
  await sb.from('moderation_log').insert({ actor_id: st.uid, action: 'drive_connected', target_type: 'gallery', target_id: folderId,
    details: { account: email } });
  await runGallerySync({ sb, env, fetchImpl }).catch(() => {});
  return 'drive=connected';
}

async function accessToken(sb, env, fetchImpl) {
  const secret = tokenSecret(env);
  const { data: conn } = await sb.from('drive_connection').select('*').eq('id', 1).maybeSingle();
  if (!conn) throw new HttpError(409, 'Google Drive is not connected yet. Press "Connect Google Drive" first.');
  let refresh;
  try { refresh = decryptToken(conn.refresh_token_enc, secret); }
  catch { throw new HttpError(409, 'The saved Drive connection cannot be read (the key in Vercel changed). Connect Google Drive again.'); }
  try {
    const t = await refreshAccess(env, refresh, fetchImpl);
    return { conn, token: t.access_token, expires_in: t.expires_in || 3600 };
  } catch (e) { throw new HttpError(409, e.message); }
}

export async function handleAction({ sb, env, user, body, fetchImpl = fetch }) {
  const action = String(body?.action || '');
  if (action === 'status') {
    const { data: conn } = await sb.from('drive_connection').select('account_email,upload_folder_id,connected_at').eq('id', 1).maybeSingle();
    return {
      listing: !!env.GOOGLE_API_KEY, uploads: uploadsConfigured(env), connected: !!conn,
      account_email: conn?.account_email || null, connected_at: conn?.connected_at || null,
      upload_folder_id: conn?.upload_folder_id || null, folders: galleryFolders(env, conn?.upload_folder_id),
    };
  }
  if (action === 'sync') {
    let out;
    try { out = await runGallerySync({ sb, env, fetchImpl }); }
    catch (e) { out = { ok: false, error: redact(e.message, env) }; }
    await sb.from('moderation_log').insert({ actor_id: user.id, action: out.ok ? 'gallery_synced' : 'gallery_sync_failed', target_type: 'gallery',
      details: out.ok ? { added: out.added, removed: out.removed, total: out.total } : { error: out.error } });
    if (!out.ok) throw new HttpError(502, out.error);
    return out;
  }
  if (action === 'connect-url') {
    if (!uploadsConfigured(env)) throw new HttpError(400, 'Drive uploads are not set up yet: add GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET (and TOKEN_ENC_KEY) in Vercel.');
    const state = signState({ uid: user.id, exp: Date.now() + 10 * 60_000, n: Math.random().toString(36).slice(2) }, tokenSecret(env));
    return { url: consentUrl(env, state) };
  }
  if (action === 'upload-token') {
    if (!uploadsConfigured(env)) throw new HttpError(400, 'Drive uploads are not set up yet.');
    const { conn, token, expires_in } = await accessToken(sb, env, fetchImpl);
    return { access_token: token, expires_in, folder_id: conn.upload_folder_id };
  }
  if (action === 'disconnect') {
    const { data: conn } = await sb.from('drive_connection').select('refresh_token_enc').eq('id', 1).maybeSingle();
    if (conn && tokenSecret(env)) {
      try {
        const t = decryptToken(conn.refresh_token_enc, tokenSecret(env));
        await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t }).toString() });
      } catch { /* forget it here anyway */ }
    }
    await sb.from('drive_connection').delete().eq('id', 1);
    await sb.from('moderation_log').insert({ actor_id: user.id, action: 'drive_disconnected', target_type: 'gallery' });
    return { ok: true };
  }
  throw new HttpError(400, 'Unknown action.');
}

export default wrap(async (req, res) => {
  const env = process.env;
  const sb = serviceClient(env);
  if (req.method === 'GET') {
    const url = new URL(req.url, 'https://x');
    let query;
    try { query = await handleCallback({ sb, env, query: Object.fromEntries(url.searchParams) }); }
    catch (e) { query = 'drive=error&msg=' + encodeURIComponent(redact(e.message, env).slice(0, 200)); }
    return back(res, query);
  }
  if (req.method === 'POST') {
    const { user } = await requireAdmin(sb, req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    return send(res, 200, await handleAction({ sb, env, user, body }));
  }
  res.setHeader('allow', 'GET, POST');
  throw new HttpError(405, 'Method not allowed.');
});
