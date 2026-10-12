/* Supabase project for cloud sync. The anon key is public by design: row-level security in
   supabase/migrations/0001_init.sql decides what each signed-in user can read and write.
   Leave both empty to run without the cloud: results then stay in this browser only. */
window.VECTOR_CONFIG = {
  supabaseUrl: "https://ehkjtowrcsplidjjjjca.supabase.co",       // e.g. "https://abcdefgh.supabase.co"
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoa2p0b3dyY3NwbGlkampqamNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MzcwNjEsImV4cCI6MjEwNzMxMzA2MX0.5aJ67oa0dX7zsPoFEmcSnrSR1X7hGnlQlEO1eNVMkvc",   // Project settings > API > anon public key
};
