/* SIMATS Anime Club — shared browser code for the members area and admin dashboard.
   Security note: nothing here decides who may do what. Every action is checked again
   by the database (RLS + functions) or by the /api functions on the server. */
(function () {
  'use strict';
  const cfg = window.CLUB_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseKey && !/PASTE_/.test(cfg.supabaseKey) && window.supabase);
  const TZ = 'Asia/Kolkata';

  const sb = configured
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      })
    : null;

  const state = { ready: false, session: null, user: null, profile: null };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });

  // ---------- tiny DOM helpers (text is always inserted as text, never as HTML) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------- time (always India time) ----------
  const fmt = (d, opts) => new Date(d).toLocaleString('en-IN', { timeZone: TZ, ...opts });
  const OFFICES = { president: 'President', vice_president: 'Vice President', secretary: 'Secretary', treasurer: 'Treasurer' };
  const fmtDateTime = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtDate = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
  const isMidnightIst = (d) => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00') === '00:00';
  function ago(d) {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return fmtDate(d);
  }
  // <input type="datetime-local"> <-> ISO, read as India time
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const t = new Date(new Date(iso).getTime() + 5.5 * 3600e3);
    return t.toISOString().slice(0, 16);
  };
  const fromLocalInput = (v) => (v ? new Date(v + ':00+05:30').toISOString() : null);

  // ---------- feedback ----------
  let toastBox;
  function toast(msg, kind = '') {
    if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
    const t = h('div', { class: 'toast ' + kind, text: msg });
    toastBox.append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4200);
  }

  function friendly(err) {
    const m = (err && (err.message || err.error_description || err.error)) || String(err || '');
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
    if (/JWT expired|invalid JWT|session.*expired/i.test(m)) return 'Your session expired. Please sign in again.';
    if (/permission denied/i.test(m)) return 'You are not allowed to do that.';
    return m.replace(/^(ERROR:\s*)/, '') || 'Something went wrong.';
  }

  // Disable a button while a promise runs; show a spinner.
  async function busy(btn, fn) {
    if (!btn) return fn();
    const old = [...btn.childNodes];
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    btn.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }), ' ', ...old.map((n) => n.cloneNode(true)));
    try { return await fn(); }
    finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.replaceChildren(...old); }
  }

  // Modal dialog. Returns the entered text (or true) on OK, null on cancel.
  function ask({ title, text, confirm = 'OK', danger = false, input = null }) {
    return new Promise((resolve) => {
      let field;
      if (input) {
        field = input.multiline
          ? h('textarea', { class: 'input', maxlength: input.max || 300, placeholder: input.placeholder || '', rows: 3 })
          : h('input', { class: 'input', maxlength: input.max || 300, placeholder: input.placeholder || '' });
        field.value = input.value || '';
      }
      const err = h('div', { class: 'note err', hidden: true });
      const dlg = h('dialog', { class: 'dlg' },
        h('form', { method: 'dialog' },
          h('h3', { text: title }),
          text ? h('p', { class: 'sub', text }) : null,
          field ? h('label', { class: 'f' }, h('span', null, input.label || 'Reason', input.required ? '' : h('em', { text: ' (optional)' })), field) : null,
          err,
          h('div', { class: 'row end' },
            h('button', { class: 'btn ghost', value: 'cancel', type: 'submit', formnovalidate: true, text: 'Cancel' }),
            h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), value: 'ok', type: 'submit', text: confirm }))));
      dlg.querySelector('form').addEventListener('submit', (e) => {
        if (e.submitter?.value === 'ok' && input?.required && field.value.trim().length < (input.min || 3)) {
          e.preventDefault(); err.hidden = false; err.textContent = input.requiredMsg || 'Please fill this in.'; field.focus();
        }
      });
      dlg.addEventListener('close', () => {
        const ok = dlg.returnValue === 'ok';
        resolve(ok ? (field ? field.value.trim() : true) : null);
        dlg.remove();
      });
      document.body.append(dlg);
      dlg.showModal();
      (field || dlg.querySelector('button[value="ok"]')).focus();
    });
  }

  // ---------- data access ----------
  async function rpc(fn, args) {
    if (!sb) throw new Error('The members area is not set up yet.');
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw new Error(friendly(error));
    return data;
  }
  async function api(path, body) {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body || {}),
      });
    } catch (e) { throw new Error(friendly(e)); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(out.error || `Request failed (${res.status}).`); e.result = out; e.status = res.status; throw e; }
    return out;
  }

  // The last profile this browser saw for this account, shown instantly on the next visit while the
  // fresh copy loads. Display only: every action is checked again by the database.
  const PROFILE_KEY = 'club.profile.';
  function readCachedProfile(uid) {
    try { const p = JSON.parse(localStorage.getItem(PROFILE_KEY + uid) || 'null'); return p && p.id === uid ? p : null; } catch { return null; }
  }
  function cacheProfile(uid, p) {
    try { if (p) localStorage.setItem(PROFILE_KEY + uid, JSON.stringify(p)); else localStorage.removeItem(PROFILE_KEY + uid); } catch { /* storage unavailable */ }
  }
  function clearCachedProfiles() {
    try { Object.keys(localStorage).filter((k) => k.startsWith(PROFILE_KEY)).forEach((k) => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
  }

  async function loadProfile() {
    if (!state.user) { state.profile = null; return; }
    const uid = state.user.id;
    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
      if (error) { console.error(error); if (!state.profile) state.profile = null; return; }   // keep the cached copy on a network error
      if (data) { state.profile = data; cacheProfile(uid, data); return; }
      await new Promise((r) => setTimeout(r, 600));   // the sign-up trigger can lag a moment on first sign-in
    }
    state.profile = null; cacheProfile(uid, null);
  }
  async function refreshProfile() { await loadProfile(); emit(); return state.profile; }

  async function setSession(session) {
    state.session = session; state.user = session?.user || null;
    state.profile = state.user ? readCachedProfile(state.user.id) : null;
    if (state.profile) { state.ready = true; emit(); }   // paint straight away from the last visit
    await loadProfile();
    state.ready = true;
    emit();
  }

  async function init() {
    // OAuth errors come back in the address bar
    const qs = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
    if (qs.get('error_description')) {
      toast('Sign-in failed: ' + qs.get('error_description'), 'err');
      history.replaceState(null, '', location.pathname);
    }
    if (!sb) { state.ready = true; emit(); return; }
    const { data } = await sb.auth.getSession();
    await setSession(data.session);
    if (/[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
    sb.auth.onAuthStateChange((event, session) => {
      // run outside the auth callback (the client warns against awaiting inside it)
      if (event === 'INITIAL_SESSION') return;          // already handled by getSession() above
      if (event === 'TOKEN_REFRESHED') { state.session = session; return; }
      if (event === 'SIGNED_IN' && state.user && session?.user?.id === state.user.id) { state.session = session; return; }
      setTimeout(() => setSession(session), 0);
    });
  }

  async function signIn() {
    if (!sb) return toast('The members area is not set up yet.', 'err');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } },
    });
    if (error) toast(friendly(error), 'err');
  }
  async function signOut() {
    clearCachedProfiles();
    if (sb) await sb.auth.signOut();
    toast('Signed out. Mata ne!');
  }

  // ---------- avatar ----------
  function avatar(url, name, cls = '') {
    const initials = (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const fb = () => h('span', { class: 'avatar fallback ' + cls, 'aria-hidden': 'true', text: initials });
    if (!url || !/^https:\/\//.test(url)) return fb();
    const img = h('img', { class: 'avatar ' + cls, src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', width: 28, height: 28 });
    img.addEventListener('error', () => img.replaceWith(fb()), { once: true });
    return img;
  }

  const GOOGLE_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.2-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
  function googleButton(label = 'Sign in with Google') {
    const b = h('button', { class: 'btn btn-google', type: 'button', onclick: (e) => busy(e.currentTarget, signIn) });
    b.insertAdjacentHTML('afterbegin', GOOGLE_ICON);   // static, trusted markup
    b.append(' ', label);
    return b;
  }

  // ---------- header account menu ----------
  function mountAccount(slot) {
    const render = () => {
      slot.replaceChildren();
      if (!state.ready) return;
      if (canSeeNotices()) {
        slot.append(bell.el || buildBell());
        const who = (state.user?.id || 'visitor') + (isMember() ? ':m' : ':v');
        if (bell.forUser !== who) { bell.forUser = who; refreshBell(); }
      }
      if (!state.user) { slot.append(googleButton('Sign in')); return; }
      const p = state.profile || {};
      const name = p.full_name || p.google_name || state.user.email;
      const wrap = h('div', { class: 'acct' });
      const menu = h('div', { class: 'acct-menu', role: 'menu' },
        h('div', { class: 'who' }, name, h('small', { text: state.user.email })),
        h('a', { href: '/members', role: 'menuitem', text: 'My membership' }),
        p.is_admin ? h('a', { href: '/admin', role: 'menuitem', text: 'Admin dashboard' }) : null,
        h('a', { href: '/', role: 'menuitem', text: 'Back to the site' }),
        h('button', { type: 'button', role: 'menuitem', text: 'Sign out', onclick: () => signOut() }));
      const btn = h('button', { class: 'acct-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false',
        onclick: (e) => { e.stopPropagation(); const o = wrap.classList.toggle('open'); btn.setAttribute('aria-expanded', String(o)); } },
        avatar(p.avatar_url, name), h('span', { class: 'nm', text: (name || '').split(/\s+/)[0].slice(0, 16).toUpperCase() }));
      wrap.append(btn, menu);
      slot.append(wrap);
    };
    document.addEventListener('click', () => $$('.acct.open').forEach((a) => a.classList.remove('open')));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.acct.open').forEach((a) => a.classList.remove('open')); });
    listeners.add(render);
    render();
    every(120000, refreshBell);           // pick up new notices while the page is open
  }

  // ---------- notices bell (approved members) ----------
  const bell = { el: null, badge: null, btn: null, list: null, forUser: null };
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6v-5a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
  // Notices are public. Approved members get the "new" marker from the database (same on every device);
  // everyone else gets it from this browser.
  const canSeeNotices = () => !!sb;
  const isMember = () => !!(state.user && state.profile?.membership_status === 'approved');
  const SEEN_KEY = 'club.noticesSeenAt';
  const localSeen = () => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } };
  const setLocalSeen = (t) => { try { if (t && t > localSeen()) localStorage.setItem(SEEN_KEY, t); } catch { /* storage unavailable */ } };
  function buildBell() {
    const badge = h('span', { class: 'bell-badge', hidden: true });
    const btn = h('button', { class: 'bell-btn', type: 'button', 'aria-label': 'Notices', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    btn.innerHTML = BELL_SVG;                // fixed icon markup, no user data
    btn.append(badge);
    const list = h('div', { class: 'bell-list' });
    const panel = h('div', { class: 'bell-panel', role: 'dialog', 'aria-label': 'Club notices' },
      h('div', { class: 'bell-head' }, h('strong', { text: 'NOTICES' }), h('span', { text: 'From the club admins' })), list);
    const wrap = h('div', { class: 'bell' }, btn, panel);
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => toggleBell(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleBell(false); });
    Object.assign(bell, { el: wrap, badge, btn, list });
    return wrap;
  }
  function setUnread(n) {
    if (!bell.badge) return;
    bell.badge.hidden = !n;
    bell.badge.textContent = n > 9 ? '9+' : String(n || '');
    bell.btn.setAttribute('aria-label', n ? `Notices, ${n} new` : 'Notices');
  }
  async function refreshBell() {
    if (!canSeeNotices() || !bell.el) return;
    try {
      if (isMember()) { setUnread((await rpc('notice_unread_count')) || 0); return; }
      const seen = localSeen();
      const list = (await rpc('list_notices', { p_limit: 30 })) || [];
      setUnread(list.filter((n) => !seen || n.created_at > seen).length);
    } catch { /* keep the last count */ }
  }
  async function toggleBell(force) {
    if (!bell.el) return;
    const open = force ?? !bell.el.classList.contains('open');
    if (force !== undefined && open === bell.el.classList.contains('open')) return;   // already in that state
    bell.el.classList.toggle('open', open);
    bell.btn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    bell.list.replaceChildren(h('div', { class: 'bell-empty', text: 'Loading notices…' }));
    try {
      let items = (await rpc('list_notices', { p_limit: 50 })) || [];
      if (!isMember()) { const seen = localSeen(); items = items.map((n) => ({ ...n, is_new: !seen || n.created_at > seen })); }
      bell.list.replaceChildren(...(items.length ? items.map(noticeItem)
        : [h('div', { class: 'bell-empty', text: 'No notices yet. Club announcements and cancelled meetings show up here.' })]));
      setUnread(0);
      if (items.length) setLocalSeen(items[0].created_at);
      if (isMember() && items.some((n) => n.is_new)) rpc('mark_notices_seen').catch(() => {});
    } catch (e) { bell.list.replaceChildren(h('div', { class: 'bell-empty', text: e.message })); }
  }
  function noticeItem(n) {
    const cancelled = n.kind === 'cancellation';
    const by = n.author_name + (n.author_position && OFFICES[n.author_position] ? ', ' + OFFICES[n.author_position] : '');
    return h('article', { class: 'bell-item' + (n.is_new ? ' new' : '') + (cancelled ? ' cancel' : '') },
      h('div', { class: 'bell-meta' },
        h('span', { class: 'bell-tag', text: cancelled ? 'MEETING CANCELLED' : 'NOTICE' }),
        n.is_new ? h('span', { class: 'bell-new', text: 'NEW' }) : null,
        h('time', { datetime: n.created_at, text: fmtDateTime(n.created_at) })),
      h('h4', { text: n.title }),
      h('p', { text: n.body }),
      h('div', { class: 'bell-by', text: '— ' + by }));
  }

  // Run fn while the tab is visible, every ms.
  function every(ms, fn) {
    let t = 0;
    const tick = () => { clearTimeout(t); if (!document.hidden) fn(); t = setTimeout(tick, ms); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    t = setTimeout(tick, ms);
    return () => clearTimeout(t);
  }

  window.Club = {
    sb, state, configured, init, signIn, signOut, refreshProfile, rpc, api,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    h, $, $$, toast, ask, busy, friendly, avatar, googleButton, mountAccount, every,
    fmt, fmtDate, fmtDateTime, fmtTime, ago, isMidnightIst, toLocalInput, fromLocalInput, TZ,
    OFFICES, openNotices: () => toggleBell(true), refreshBell,
  };
})();
