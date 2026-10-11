/* Cloud sync with Supabase (supabase/migrations/0001_init.sql):
   - sign-in by an emailed link; accounts are invited by the institute, so sign-in never creates one
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

  let client = null;
  let session = null;
  let seat = null;
  let flushing = false;
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
    if (!s) { seat = null; set({ status: state.status === 'link_sent' ? 'link_sent' : 'signed_out' }); return; }
    const userId = s.user.id;
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

  /* Queue one call_outcomes row. institute_id and seat_id are filled from the seat signed in now,
     so a row is only ever uploaded under the seat that made it. Returns false when there is no seat. */
  function enqueue(row) {
    if (!seat) return false;
    const q = read(QUEUE, []);
    q.push(Object.assign({}, row, { institute_id: seat.institute_id, seat_id: seat.id }));
    write(QUEUE, q);
    counts(); emit();
    flush();
    return true;
  }

  async function flush() {
    if (!client || !seat || flushing || state.status === 'no_seat') return;
    flushing = true;
    try {
      let q = read(QUEUE, []);
      for (let i = 0; i < q.length;) {
        const row = q[i];
        if (row.seat_id !== seat.id) { i++; continue; }   // another account's rows wait for that account
        // ignoreDuplicates: a retried upload of the same (seat_id, client_record_id) is skipped, not an error.
        const { error } = await client.from('call_outcomes').upsert(row, { onConflict: 'seat_id,client_record_id', ignoreDuplicates: true });
        if (error) {
          const code = String(error.code || '');
          if (code === '42501' || code === 'PGRST301' || !code) {
            // No permission (seat revoked), expired login, or no network: stop and retry later.
            set({ lastError: error.message, status: code === '42501' ? 'no_seat' : state.status });
            break;
          }
          // The row itself is invalid: park it so it does not block the rest.
          const failed = read(FAILED, []); failed.push({ row, error: error.message }); write(FAILED, failed);
        }
        q.splice(i, 1);
        write(QUEUE, q);
        state.lastSyncedAt = Date.now();
      }
      if (state.status === 'offline' && state.lastSyncedAt) state.status = 'ready';
    } finally {
      flushing = false;
      counts(); emit();
    }
  }

  window.Cloud = {
    enabled,
    init,
    info,
    sendLink,
    signOut,
    enqueue,
    flush,
    retry: () => { if (session) onSession(session); },
    onChange: (fn) => { listeners.push(fn); },
    hasSeat: () => !!seat,
    /** Calls finished before this account first signed in on this browser are not uploaded. */
    since: () => (session ? read(SINCE, {})[session.user.id] || 0 : Infinity),
  };
})();
