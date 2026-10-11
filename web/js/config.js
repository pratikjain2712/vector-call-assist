/* Supabase project for cloud sync. The anon key is public by design: row-level security in
   supabase/migrations/0001_init.sql decides what each signed-in user can read and write.
   Leave both empty to run without the cloud: results then stay in this browser only. */
window.VECTOR_CONFIG = {
  supabaseUrl: "",       // e.g. "https://abcdefgh.supabase.co"
  supabaseAnonKey: "",   // Project settings > API > anon public key
};
