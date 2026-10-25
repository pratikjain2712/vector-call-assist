-- Fixed search_path on the helper functions the Supabase security check flagged
-- ("function_search_path_mutable"), so a caller's own search_path can never change which objects they use.
alter function public.admin_check_range(timestamptz, timestamptz) set search_path = public;
alter function public.ai_month_start() set search_path = public;
alter function public.ai_monthly_limit(text) set search_path = public;
alter function public.insights_kept_keys(text) set search_path = public;
alter function public.script_has_check_mark(jsonb) set search_path = public;
alter function public.wa_body_params(text) set search_path = public;
alter function public.wa_brief_available() set search_path = public;
alter function public.wa_month_start() set search_path = public;
alter function public.wa_rate(text) set search_path = public;
