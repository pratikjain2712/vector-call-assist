// What the whatsapp-* Edge Functions get from the outside world, in one place: the environment, fetch, the
// database (service role, through RPCs only) and the check of the caller's login. index.ts builds this once;
// the tests (tests/web/whatsapp-functions.test.js) pass their own fakes instead.
// createClient is supabase-js's, passed in so this file has no imports and also loads in Node.
export function makeDeps(createClient, env) {
  const url = env.SUPABASE_URL || '';
  const service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !service) console.error('whatsapp: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing');
  const svc = url && service
    ? createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    // A database function with the service role. Errors keep Postgres's code (42501, 22023 …).
    async rpc(name, args) {
      if (!svc) throw Object.assign(new Error('server not configured'), { code: 'CONFIG' });
      const { data, error } = await svc.rpc(name, args);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data;
    },
    // The user id of a "Bearer <access token>" header, checked with Supabase Auth; null when not valid.
    async userId(authorization) {
      if (!svc) return null;
      const token = String(authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return null;
      const { data, error } = await svc.auth.getUser(token);
      return error || !data || !data.user ? null : data.user.id;
    },
  };
}
