/* Cloud sync with Supabase (supabase/migrations/0001_init.sql):
   - sign-in by an emailed link; accounts are invited by the institute, so sign-in never creates one
   - an invited seat is linked to the login once per sign-in, with claim_my_invite()
   - the rep's active seat, from my_active_seat()
   - an upload queue for call_outcomes rows, kept in this browser until the upload succeeds
   Only outcomes and timings leave the browser: never lead names or phone numbers. */
(function () {
  const cfg = window.VECTOR_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const QUEUE = 'vca2-cloud-queue';
  const FAILED = 'vca2-cloud-failed';
  const SEAT_CACHE = 'vca2-cloud-seat';
  const SINCE = 'vca2-cloud-since';   // per account: calls before this time stay local
  const UPLOADED = 'vca2-cloud-uploaded';   // keys of rows already uploaded (newest last): never sent twice
  const UPLOADED_KEEP = 300;

  let client = null;
  let session = null;
  let seat = null;
  let flushing = false;
  let inFlight = null;   // id of the row being uploaded right now
  let claimedFor = null; // user id whose invitation was tried this sign-in (cleared on sign-out)
  const listeners = [];
  // status: off | starting | signed_out | link_sent | no_seat | ready | offline | error
  const state = { status: enabled ? 'starting' : 'off', pending: 0, failed: 0, lastError: '', lastSyncedAt: 0 };

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function info() {
    return Object.assign({ enabled }, state, {
      email: session && session.user ? session.user.email : '',
      seatLabel: seat ? seat.label : '',
      role: seat ? seat.role : '',
      instituteId: seat ? seat.institute_id : '',
    });
  }
  function emit() { listeners.forEach((fn) => { try { fn(info()); } catch (e) {} }); }
  function set(patch) { Object.assign(state, patch); emit(); }
  function counts() { state.pending = read(QUEUE, []).length; state.failed = read(FAILED, []).length; }

  async function init() {
    counts();
    if (!enabled) { emit(); return; }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Supabase advises not to call the client inside this callback, so the work runs just after it.
    client.auth.onAuthStateChange((_event, s) => { setTimeout(() => onSession(s), 0); });
    window.addEventListener('online', () => { if (session) onSession(session); });
    setInterval(flush, 30000);
  }

  async function onSession(s) {
    session = s;
    if (!s) { seat = null; claimedFor = null; set({ status: state.status === 'link_sent' ? 'link_sent' : 'signed_out' }); return; }
    const userId = s.user.id;
    await claimInvite(userId);
    const { data, error } = await client.rpc('my_active_seat');
    if (error) {
      // Offline or the project is unreachable: keep working with the seat seen last time.
      const cached = read(SEAT_CACHE, null);
      if (cached && cached.user_id === userId) { seat = cached; set({ status: 'offline', lastError: error.message }); }
      else set({ status: 'error', lastError: error.message });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    seat = row && row.id ? row : null;
    if (seat) {
      write(SEAT_CACHE, seat);
      const since = read(SINCE, {});
      if (!since[userId]) { since[userId] = Date.now(); write(SINCE, since); }
    }
    set({ status: seat ? 'ready' : 'no_seat', lastError: '' });
    if (seat) flush();
  }

  /* An invited person's login is linked to their invited seat here, once per sign-in. "No invitation" (or a
     seat already held) is the usual answer and is ignored. A network failure is tried again on the next session change. */
  async function claimInvite(userId) {
    if (!client || claimedFor === userId) return;
    try {
      const { error } = await client.rpc('claim_my_invite');
      if (error && !error.code) return;
    } catch (e) { return; }
    claimedFor = userId;
  }

  async function sendLink(email) {
    if (!client) throw new Error('Cloud sign-in is not set up on this site.');
    const clean = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('Enter your work email address.');
    const { error } = await client.auth.signInWithOtp({
      email: clean,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) {
      if (/signup|not allowed|not found/i.test(error.message)) throw new Error('This email has no Vector account. Ask your institute admin to invite you.');
      throw new Error(error.message);
    }
    set({ status: 'link_sent', lastError: '' });
  }

  async function signOut() {
    if (client) await client.auth.signOut();
    seat = null;
    set({ status: enabled ? 'signed_out' : 'off' });
  }

  /* A call is one upload: the same seat and client_record_id always mean the same call. */
  function keyOf(row) { return row.seat_id + '|' + row.client_record_id; }
  function uploaded(key) { return read(UPLOADED, []).includes(key); }
  function markUploaded(key) {
    const list = read(UPLOADED, []).filter((k) => k !== key);
    list.push(key);
    write(UPLOADED, list.slice(-UPLOADED_KEEP));
  }
  function removeQueued(id) { write(QUEUE, read(QUEUE, []).filter((r) => r.id !== id)); }

  /* Queue one call_outcomes row. institute_id and seat_id are filled from the seat signed in now,
     so a row is only ever uploaded under the seat that made it. Returns false when there is no seat.
     A row already queued or already uploaded is not added again (returns true: it is handled). */
  function enqueue(row) {
    if (!seat) return false;
    const full = Object.assign({}, row, { institute_id: seat.institute_id, seat_id: seat.id });
    const key = keyOf(full);
    const q = read(QUEUE, []);
    if (uploaded(key) || q.some((r) => r.id === full.id || keyOf(r) === key)) return true;
    q.push(full);
    write(QUEUE, q);
    counts(); emit();
    flush();
    return true;
  }

  /* Undo: take queued rows back out before they upload. Returns false, and removes nothing, when any of
     them has already uploaded or is uploading now. */
  function cancel(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const q = read(QUEUE, []);
    if (list.some((id) => id === inFlight || !q.some((r) => r.id === id))) return false;
    write(QUEUE, q.filter((r) => !list.includes(r.id)));
    counts(); emit();
    return true;
  }

  /* Uploads queued rows one at a time. The queue is read again before each upload, so a row added while an
     upload is in flight is not lost. A network error stops the pass and keeps every row queued for the next try. */
  async function flush() {
    if (!client || !seat || flushing || state.status === 'no_seat') return;
    flushing = true;
    const waiting = new Set();   // rows that belong to another seat: they wait for that account
    try {
      for (;;) {
        const row = read(QUEUE, []).find((r) => !waiting.has(r.id));
        if (!row) break;
        if (row.seat_id !== seat.id) { waiting.add(row.id); continue; }
        if (uploaded(keyOf(row))) { removeQueued(row.id); continue; }   // never send the same call twice
        let error = null;
        inFlight = row.id;
        try {
          // ignoreDuplicates: a retried upload of the same (seat_id, client_record_id) is skipped, not an error.
          const res = await client.from('call_outcomes').upsert(row, { onConflict: 'seat_id,client_record_id', ignoreDuplicates: true });
          error = (res && res.error) || null;
        } catch (e) {
          error = { message: (e && e.message) || 'Network error' };
        } finally { inFlight = null; }
        if (!error) {
          markUploaded(keyOf(row));
          removeQueued(row.id);
          state.lastSyncedAt = Date.now();
          if (state.status === 'offline' || state.status === 'error') { state.status = 'ready'; state.lastError = ''; }
          continue;
        }
        const code = String(error.code || '');
        if (!code) {
          // No network, or the project cannot be reached: stop and keep every row for the next try.
          state.status = 'offline'; state.lastError = error.message || 'Network error';
          break;
        }
        if (code === '42501') {
          // No permission (seat revoked): stop and keep the rows.
          state.status = 'no_seat'; state.lastError = error.message || '';
          break;
        }
        if (code === 'PGRST301') {
          // Login expired: stop and keep the rows until the rep signs in again.
          state.status = 'error'; state.lastError = 'Sign in again. ' + (error.message || '');
          break;
        }
        // The row itself is invalid: park it so it does not block the rest.
        const failed = read(FAILED, []); failed.push({ row: row, error: error.message || code }); write(FAILED, failed);
        removeQueued(row.id);
      }
    } finally {
      flushing = false;
      counts(); emit();
    }
  }

  /* A database function call with the signed-in rep's session. Resolves { data, error }; rejects when not
     signed in or when the network fails. Used for terms acceptance and feedback. */
  async function rpc(name, args) {
    if (!client || !session) throw new Error('Not signed in to the Vector cloud.');
    const res = await client.rpc(name, args || {});
    return { data: res.data, error: res.error || null };
  }

  /* The published script for the signed-in rep's institute: { scriptId, version, steps }, or null when there is
     none, cloud is off, nobody is signed in, or the read fails. RLS lets a rep read published versions only. */
  async function publishedScript() {
    try {
      if (!client || !session || !seat) return null;
      const { data, error } = await client
        .from('scripts')
        .select('id, script_versions!inner(version, steps, published)')
        .eq('institute_id', seat.institute_id)
        .eq('script_versions.published', true)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error || !Array.isArray(data) || !data[0]) return null;
      const v = Array.isArray(data[0].script_versions) ? data[0].script_versions[0] : data[0].script_versions;
      if (!v || !Array.isArray(v.steps)) return null;
      return { scriptId: data[0].id, version: v.version, steps: v.steps };
    } catch (e) { return null; }
  }

  window.Cloud = {
    enabled,
    init,
    info,
    sendLink,
    signOut,
    rpc,
    publishedScript,
    enqueue,
    cancel,
    flush,
    retry: () => { if (session) onSession(session); },
    onChange: (fn) => { listeners.push(fn); },
    hasSeat: () => !!seat,
    /** Calls finished before this account first signed in on this browser are not uploaded. */
    since: () => (session ? read(SINCE, {})[session.user.id] || 0 : Infinity),
  };
})();
