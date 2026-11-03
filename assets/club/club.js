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

  async function loadProfile() {
    if (!state.user) { state.profile = null; return; }
    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
      if (error) { console.error(error); break; }
      if (data) { state.profile = data; return; }
      await new Promise((r) => setTimeout(r, 600));   // the sign-up trigger can lag a moment on first sign-in
    }
    state.profile = null;
  }
  async function refreshProfile() { await loadProfile(); emit(); return state.profile; }

  async function setSession(session) {
    state.session = session; state.user = session?.user || null;
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
      if (!state.user) { slot.append(googleButton('Sign in')); return; }
      const p = state.profile || {};
      const name = p.full_name || p.google_name || state.user.email;
      const wrap = h('div', { class: 'acct' });
      const menu = h('div', { class: 'acct-menu', role: 'menu' },
        h('div', { class: 'who' }, name, h('small', { text: state.user.email })),
        h('a', { href: '/members#account', role: 'menuitem', text: 'My membership' }),
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
  };
})();
