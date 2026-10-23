-- Vector 2.0 Phase A, Sprint 12: WhatsApp (Meta WhatsApp Cloud API). Apply after 20261024100014.
--
-- What is here:
--   whatsapp_accounts    the institute's WhatsApp Business number (ids and display name; never the token).
--   whatsapp_secrets     the access token, AES-256-GCM encrypted by the Edge Function with the server secret
--                        WHATSAPP_TOKEN_KEY. The database never sees the plain token, and no browser role can
--                        read this table at all (RLS on, no policy, no grant). Why not one Supabase secret per
--                        institute: secrets need a CLI deploy per institute and every function would see every
--                        token. Why not Supabase Vault: the key would sit in the same database as the data.
--   whatsapp_templates   message templates per call-type ending, with their Meta approval status.
--   whatsapp_messages    every message out and every reply in, with status and an estimated cost.
--   whatsapp_brief_recipients  owners who asked for the weekly brief on WhatsApp.
--
-- Who reads what (RLS): admins (owners and managers) read their institute's account, templates and messages.
-- A caller reads approved templates of their institute and the messages of leads assigned to their active
-- seat. Nobody writes from the browser: admins use the admin_whatsapp_* functions below, and the Edge
-- Functions (supabase/functions/whatsapp-*) use the wa_* functions, which are granted to service_role only.
--
-- Money rules (docs/data-contract.md): message bodies are stored with amounts masked ("₹…"), so the log
-- never holds an amount. The estimated WhatsApp cost is shown only when can_see_money() is true.
-- Consent: a message goes only to a lead with consent_whatsapp true and do_not_call false. A reply STOP
-- (or a Hindi or Hinglish variant, recognised by the webhook) turns consent_whatsapp off.
-- Meta India rates (June 2026, before GST): utility ₹0.115, marketing ₹0.86 a message (wa_rate below).

-- ---------- tables ----------

create table public.whatsapp_accounts (
  institute_id     uuid primary key references public.institutes (id) on delete cascade,
  phone_number_id  text not null unique check (phone_number_id ~ '^[0-9]{5,30}$'),
  waba_id          text not null check (waba_id ~ '^[0-9]{5,30}$'),
  display_name     text not null check (length(display_name) between 1 and 80),
  display_phone    text check (length(display_phone) <= 30),
  -- connected: messages can go out. disconnected: switched off by an owner (the token is deleted).
  -- error: Meta refused the token or the number; an owner must connect again.
  status           text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  -- stored: the institute's own token in whatsapp_secrets. platform: our own system-user token (server secret
  -- WHATSAPP_PLATFORM_TOKEN), for institutes we connect through our Meta business.
  token_source     text not null default 'stored' check (token_source in ('stored', 'platform')),
  last_error       text check (length(last_error) <= 300),
  connected_by     uuid references auth.users (id) on delete set null,
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.whatsapp_secrets (
  institute_id  uuid primary key references public.institutes (id) on delete cascade,
  -- 'v1:<iv base64>:<ciphertext base64>', made by supabase/functions/_shared/whatsapp.mjs encryptToken().
  token_cipher  text not null check (token_cipher ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' and length(token_cipher) <= 4000),
  updated_at    timestamptz not null default now()
);

create table public.whatsapp_templates (
  id                uuid primary key default gen_random_uuid(),
  institute_id      uuid not null references public.institutes (id) on delete cascade,
  -- Our name for it, also used at Meta as 'vec_<key>'. Starter keys: fees_reminder, promise_due,
  -- course_details, weekly_brief. promise_due is used by the daily reminder, weekly_brief by the brief.
  key               text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label             text not null check (length(label) between 1 and 60),
  -- The call-type ending this is offered after (both null = offered after any call, or automatic only).
  call_type_key     text check (call_type_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  result_key        text check (result_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  language          text not null default 'en' check (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  category          text not null default 'utility' check (category in ('utility', 'marketing')),
  -- Text with {{1}}, {{2}} … Each {{n}} is filled from param_sources[n] when the message is sent.
  body              text not null check (length(body) between 1 and 1024),
  param_sources     text[] not null default '{}'
                    check (param_sources <@ array['lead_name', 'amount_due', 'promised_amount', 'promised_date',
                                                  'institute_name', 'caller_name', 'typed']::text[]
                           and coalesce(array_length(param_sources, 1), 0) <= 10),
  meta_name         text generated always as ('vec_' || key) stored,
  meta_template_id  text check (meta_template_id ~ '^[0-9]{1,40}$'),
  -- draft: not sent to Meta yet (or changed since). pending: waiting for Meta. approved: can be sent.
  meta_status       text not null default 'draft'
                    check (meta_status in ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')),
  meta_reason       text check (length(meta_reason) <= 300),
  submitted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (institute_id, key),
  check ((call_type_key is null) = (result_key is null) or result_key is null)
);

create table public.whatsapp_messages (
  id               uuid primary key default gen_random_uuid(),
  institute_id     uuid not null references public.institutes (id) on delete cascade,
  lead_id          uuid references public.leads (id) on delete set null,
  -- The seat that sent it (after a call), the owner who got it (weekly brief), null for automatic reminders
  -- and replies.
  seat_id          uuid references public.seats (id) on delete set null,
  template_id      uuid references public.whatsapp_templates (id) on delete set null,
  template_key     text,
  direction        text not null check (direction in ('out', 'in')),
  kind             text not null check (kind in ('after_call', 'reminder', 'brief', 'reply')),
  -- queued: claimed, not yet accepted by Meta. failed: Meta refused it (error says why).
  status           text not null check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  category         text check (category in ('utility', 'marketing')),
  -- Estimated cost in ₹ before GST (wa_rate). 0 for replies and failed messages. Not granted to the browser.
  cost_inr         numeric(8, 3) not null default 0 check (cost_inr >= 0),
  meta_message_id  text unique check (length(meta_message_id) <= 200),
  -- Outgoing: the text with amounts masked. Incoming: the reply text.
  body             text check (length(body) <= 4096),
  error            text check (length(error) <= 300),
  -- Set on automatic sends so the same reminder or brief never goes twice ('reminder:<lead>:<date>' …).
  dedupe_key       text check (length(dedupe_key) <= 200),
  is_stop          boolean not null default false,
  created_at       timestamptz not null default now(),
  status_at        timestamptz not null default now(),
  unique (institute_id, dedupe_key)
);

create index whatsapp_messages_lead on public.whatsapp_messages (lead_id, created_at);
create index whatsapp_messages_month on public.whatsapp_messages (institute_id, created_at);

create table public.whatsapp_brief_recipients (
  seat_id       uuid primary key references public.seats (id) on delete cascade,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  phone         text not null check (phone ~ '^\+91[0-9]{10}$'),
  created_at    timestamptz not null default now()
);

create trigger whatsapp_accounts_touch before update on public.whatsapp_accounts
  for each row execute function public.touch_updated_at();
create trigger whatsapp_templates_touch before update on public.whatsapp_templates
  for each row execute function public.touch_updated_at();

-- ---------- row-level security and privileges ----------

alter table public.whatsapp_accounts enable row level security;
alter table public.whatsapp_secrets enable row level security;
alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_brief_recipients enable row level security;

create policy whatsapp_accounts_read on public.whatsapp_accounts
  for select using (public.is_admin_of(institute_id));

create policy whatsapp_templates_read on public.whatsapp_templates
  for select using (
    public.is_admin_of(institute_id)
    or (meta_status = 'approved'
        and exists (select 1 from public.seats s
                    where s.institute_id = whatsapp_templates.institute_id
                      and s.user_id = auth.uid() and s.status = 'active')));

create policy whatsapp_messages_read on public.whatsapp_messages
  for select using (
    public.is_admin_of(institute_id)
    or (lead_id is not null and exists (
          select 1 from public.leads l join public.seats s on s.id = l.assigned_seat_id
          where l.id = whatsapp_messages.lead_id and s.user_id = auth.uid() and s.status = 'active')));

create policy whatsapp_brief_read_own on public.whatsapp_brief_recipients
  for select using (exists (select 1 from public.seats s
                            where s.id = whatsapp_brief_recipients.seat_id and s.user_id = auth.uid()));

-- whatsapp_secrets: no policy and no grant. Only the security definer functions below touch it.
revoke all on public.whatsapp_accounts, public.whatsapp_secrets, public.whatsapp_templates,
              public.whatsapp_messages, public.whatsapp_brief_recipients from anon, authenticated;
grant select on public.whatsapp_accounts, public.whatsapp_templates, public.whatsapp_brief_recipients
  to authenticated;
-- cost_inr and dedupe_key stay out: cost is shown through admin_whatsapp_overview() (money rules).
grant select (id, institute_id, lead_id, seat_id, template_id, template_key, direction, kind, status, category,
              body, error, is_stop, created_at, status_at)
  on public.whatsapp_messages to authenticated;

-- ---------- helpers ----------

-- Estimated Meta price of one message in ₹, before GST (Meta India rates, June 2026; docs/phase-a-plan.md).
create or replace function public.wa_rate(p_category text)
returns numeric
language sql immutable
as $$
  select case p_category when 'utility' then 0.115 when 'marketing' then 0.86 else 0 end::numeric;
$$;

-- The number of {{n}} parameters in a template body: n when they are exactly {{1}} … {{n}} (each at least
-- once, none missing), -1 when the numbering is wrong (a gap, a {{0}}, or a malformed {{ }}).
create or replace function public.wa_body_params(p_body text)
returns int
language plpgsql immutable
as $$
declare
  nums int[];
  m    text[];
  bad  boolean;
begin
  bad := coalesce(p_body, '') ~ '\{\{(?![0-9]{1,2}\}\})' ;
  if bad then return -1; end if;
  select coalesce(array_agg(distinct x::int order by x::int), '{}') into nums
    from (select (regexp_matches(coalesce(p_body, ''), '\{\{([0-9]{1,2})\}\}', 'g'))[1] as x) t;
  if coalesce(array_length(nums, 1), 0) = 0 then return 0; end if;
  if nums[1] <> 1 or nums[array_length(nums, 1)] <> array_length(nums, 1) then return -1; end if;
  return array_length(nums, 1);
end $$;

-- The first day of this month in India time, as a timestamp, for "this month" counts.
create or replace function public.wa_month_start()
returns timestamptz
language sql stable
as $$
  select date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
$$;

-- The active seat of a given login (for the service-role functions, which get the user id from the Edge
-- Function after it checked the JWT).
create or replace function public.wa_seat_of(p_user uuid)
returns public.seats
language sql stable security definer set search_path = public
as $$
  select s.* from public.seats s where s.user_id = p_user and s.status = 'active' limit 1;
$$;

-- ---------- admin functions (browser) ----------

-- Everything the Settings panel shows: the connection (never the token), the templates, this month's counts
-- and, when the person may see money, the estimated cost. Admins only.
create or replace function public.admin_whatsapp_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  money boolean;
  acc   jsonb;
  tpl   jsonb;
  mon   jsonb;
  brief jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin of this institute can see WhatsApp settings' using errcode = '42501';
  end if;
  money := public.can_see_money(seat.institute_id);
  select jsonb_build_object('phone_number_id', a.phone_number_id, 'waba_id', a.waba_id,
                            'display_name', a.display_name, 'display_phone', a.display_phone,
                            'status', a.status, 'token_source', a.token_source, 'last_error', a.last_error,
                            'connected_at', a.connected_at)
    into acc from public.whatsapp_accounts a where a.institute_id = seat.institute_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'key', t.key, 'label', t.label, 'call_type_key', t.call_type_key,
           'result_key', t.result_key, 'language', t.language, 'category', t.category, 'body', t.body,
           'param_sources', to_jsonb(t.param_sources), 'meta_name', t.meta_name, 'meta_status', t.meta_status,
           'meta_reason', t.meta_reason, 'submitted_at', t.submitted_at, 'updated_at', t.updated_at,
           'sent_this_month', (select count(*) from public.whatsapp_messages m
                                where m.template_id = t.id and m.direction = 'out'
                                  and m.status in ('sent', 'delivered', 'read')
                                  and m.created_at >= public.wa_month_start()))
           order by t.label), '[]'::jsonb)
    into tpl from public.whatsapp_templates t where t.institute_id = seat.institute_id;
  select jsonb_build_object(
           'from', public.wa_month_start(),
           'sent', count(*) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read')),
           'delivered', count(*) filter (where m.direction = 'out' and m.status in ('delivered', 'read')),
           'read', count(*) filter (where m.direction = 'out' and m.status = 'read'),
           'failed', count(*) filter (where m.direction = 'out' and m.status = 'failed'),
           'utility', count(*) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read')
                                         and m.category = 'utility'),
           'marketing', count(*) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read')
                                           and m.category = 'marketing'),
           'replies', count(*) filter (where m.direction = 'in'),
           'stops', count(*) filter (where m.direction = 'in' and m.is_stop),
           'cost_inr', case when money then coalesce(sum(m.cost_inr) filter (
                         where m.direction = 'out' and m.status in ('sent', 'delivered', 'read')), 0) end,
           'money_hidden', not money)
    into mon from public.whatsapp_messages m
    where m.institute_id = seat.institute_id and m.created_at >= public.wa_month_start();
  select jsonb_build_object('on', true, 'phone', b.phone) into brief
    from public.whatsapp_brief_recipients b where b.seat_id = seat.id;
  return jsonb_build_object(
    'institute_id', seat.institute_id,
    'is_owner', public.is_owner_of(seat.institute_id),
    'account', acc,
    'templates', tpl,
    'month', mon,
    'rates', jsonb_build_object('utility', public.wa_rate('utility'), 'marketing', public.wa_rate('marketing')),
    'brief', coalesce(brief, jsonb_build_object('on', false, 'phone', null)));
end $$;

-- Add (p_id null) or change a template. Admins (owners and managers). A change to the text, language,
-- category or parameters of a template already sent to Meta puts it back to draft: it must be approved again.
create or replace function public.admin_whatsapp_save_template(
  p_id uuid, p_label text, p_key text, p_call_type_key text, p_result_key text, p_language text,
  p_category text, p_body text, p_param_sources text[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  t     public.whatsapp_templates;
  v_label text := trim(coalesce(p_label, ''));
  v_body  text := trim(coalesce(p_body, ''));
  v_key   text;
  n     int;
  ct    public.call_types;
  tid   uuid;
  changed boolean;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin can change WhatsApp templates' using errcode = '42501';
  end if;
  if length(v_label) not between 1 and 60 then
    raise exception 'give the template a name of 1 to 60 characters' using errcode = '22023';
  end if;
  if length(v_body) not between 1 and 1024 then
    raise exception 'the message must be 1 to 1024 characters' using errcode = '22023';
  end if;
  n := public.wa_body_params(v_body);
  if n < 0 then
    raise exception 'number the blanks {{1}}, {{2}} … in order, with no gaps' using errcode = '22023';
  end if;
  if coalesce(array_length(p_param_sources, 1), 0) <> n then
    raise exception 'choose what fills each blank ({{1}} to {{%}})', n using errcode = '22023';
  end if;
  if n > 0 and (v_body ~ '^\{\{[0-9]+\}\}' or v_body ~ '\{\{[0-9]+\}\}[.!?]?$') then
    raise exception 'Meta does not accept a message that starts or ends with a blank' using errcode = '22023';
  end if;
  if coalesce(p_category, '') not in ('utility', 'marketing') then
    raise exception 'category must be utility or marketing' using errcode = '22023';
  end if;
  if coalesce(p_language, '') !~ '^[a-z]{2}(_[A-Z]{2})?$' then
    raise exception 'language must be a code such as en or hi' using errcode = '22023';
  end if;
  if not (coalesce(p_param_sources, '{}') <@ array['lead_name', 'amount_due', 'promised_amount', 'promised_date',
                                                    'institute_name', 'caller_name', 'typed']::text[]) then
    raise exception 'a blank has an unknown filler' using errcode = '22023';
  end if;
  if p_result_key is not null then
    select * into ct from public.call_types c
      where c.key = p_call_type_key and (c.institute_id is null or c.institute_id = seat.institute_id);
    if ct.id is null then raise exception 'call type not found' using errcode = '22023'; end if;
    if not exists (select 1 from public.call_type_results_for(ct.id, seat.institute_id) r where r.key = p_result_key) then
      raise exception 'that call ending is not a result of this call type' using errcode = '22023';
    end if;
  elsif p_call_type_key is not null
        and not exists (select 1 from public.call_types c where c.key = p_call_type_key
                          and (c.institute_id is null or c.institute_id = seat.institute_id)) then
    raise exception 'call type not found' using errcode = '22023';
  end if;

  if p_id is null then
    v_key := coalesce(nullif(trim(coalesce(p_key, '')), ''), public.key_from_label(v_label));
    if v_key !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'short name must be 2 to 40 characters: a-z, 0-9 and _, starting with a letter' using errcode = '22023';
    end if;
    if exists (select 1 from public.whatsapp_templates x where x.institute_id = seat.institute_id and x.key = v_key) then
      raise exception 'a template with this short name already exists' using errcode = '22023';
    end if;
    insert into public.whatsapp_templates (institute_id, key, label, call_type_key, result_key, language, category,
                                           body, param_sources)
      values (seat.institute_id, v_key, v_label, p_call_type_key, p_result_key, p_language, p_category, v_body,
              coalesce(p_param_sources, '{}'))
      returning id into tid;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (seat.institute_id, auth.uid(), 'whatsapp.template_added', v_key);
    return tid;
  end if;

  select * into t from public.whatsapp_templates x where x.id = p_id and x.institute_id = seat.institute_id;
  if t.id is null then raise exception 'template not found' using errcode = '22023'; end if;
  changed := t.body is distinct from v_body or t.language is distinct from p_language
             or t.category is distinct from p_category
             or t.param_sources is distinct from coalesce(p_param_sources, '{}');
  update public.whatsapp_templates set
      label = v_label, call_type_key = p_call_type_key, result_key = p_result_key, language = p_language,
      category = p_category, body = v_body, param_sources = coalesce(p_param_sources, '{}'),
      meta_status = case when changed then 'draft' else meta_status end,
      meta_reason = case when changed then null else meta_reason end
    where id = t.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'whatsapp.template_changed', t.key);
  return t.id;
end $$;

-- Delete a template here. (A template approved at Meta stays there; it is simply not used.)
create or replace function public.admin_whatsapp_delete_template(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  k    text;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin can change WhatsApp templates' using errcode = '42501';
  end if;
  delete from public.whatsapp_templates where id = p_id and institute_id = seat.institute_id returning key into k;
  if k is null then raise exception 'template not found' using errcode = '22023'; end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'whatsapp.template_deleted', k);
end $$;

-- The weekly brief on WhatsApp for the signed-in owner: on with their number, or off.
create or replace function public.admin_whatsapp_brief(p_on boolean, p_phone text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  v_phone text;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only an owner can get the weekly brief on WhatsApp' using errcode = '42501';
  end if;
  if p_on is null then raise exception 'say yes or no' using errcode = '22023'; end if;
  if p_on then
    v_phone := public.normalise_phone(p_phone);
    if v_phone is null then raise exception 'enter a 10-digit Indian mobile number' using errcode = '22023'; end if;
    insert into public.whatsapp_brief_recipients (seat_id, institute_id, phone)
      values (seat.id, seat.institute_id, v_phone)
      on conflict (seat_id) do update set phone = excluded.phone;
  else
    delete from public.whatsapp_brief_recipients where seat_id = seat.id;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), case when p_on then 'whatsapp.brief_on' else 'whatsapp.brief_off' end,
            seat.id::text);
end $$;

-- The approved templates a caller can send after a call, when the institute's number is connected.
-- Empty when WhatsApp is not connected. No money.
create or replace function public.my_whatsapp_templates()
returns table (key text, label text, call_type_key text, result_key text, category text, language text,
               body text, param_sources text[])
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  return query
    select t.key, t.label, t.call_type_key, t.result_key, t.category, t.language, t.body, t.param_sources
    from public.whatsapp_templates t
    join public.whatsapp_accounts a on a.institute_id = t.institute_id and a.status = 'connected'
    where t.institute_id = seat.institute_id and t.meta_status = 'approved' and t.key <> 'weekly_brief'
    order by t.label;
end $$;

-- ---------- service-role functions (Edge Functions only) ----------

-- Who the signed-in person is for the admin Edge Function: seat, institute, owner or not, the account and the
-- encrypted token (the function decrypts it with WHATSAPP_TOKEN_KEY).
create or replace function public.wa_admin_context(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
  acc  public.whatsapp_accounts;
begin
  seat := public.wa_seat_of(p_user);
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin of this institute can do that' using errcode = '42501';
  end if;
  select * into acc from public.whatsapp_accounts where institute_id = seat.institute_id;
  return jsonb_build_object(
    'institute_id', seat.institute_id, 'seat_id', seat.id, 'is_owner', seat.admin_kind = 'owner',
    'account', case when acc.institute_id is null then null else jsonb_build_object(
      'phone_number_id', acc.phone_number_id, 'waba_id', acc.waba_id, 'display_name', acc.display_name,
      'status', acc.status, 'token_source', acc.token_source) end,
    'token_cipher', (select s.token_cipher from public.whatsapp_secrets s where s.institute_id = seat.institute_id));
end $$;

-- Connect (or reconnect) the owner's institute to a WhatsApp Business number. The Edge Function has already
-- checked the token with Meta. p_token_cipher null keeps the stored token (a change of display name only)
-- unless p_token_source is 'platform'.
create or replace function public.wa_connect(p_user uuid, p_phone_number_id text, p_waba_id text,
  p_display_name text, p_display_phone text, p_token_cipher text, p_token_source text default 'stored')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
begin
  seat := public.wa_seat_of(p_user);
  if seat.id is null or seat.role <> 'admin' or seat.admin_kind <> 'owner' then
    raise exception 'only an owner can connect WhatsApp' using errcode = '42501';
  end if;
  if exists (select 1 from public.whatsapp_accounts a
             where a.phone_number_id = p_phone_number_id and a.institute_id <> seat.institute_id) then
    raise exception 'this WhatsApp number is connected to another institute' using errcode = '22023';
  end if;
  if p_token_source = 'stored' and p_token_cipher is null
     and not exists (select 1 from public.whatsapp_secrets s where s.institute_id = seat.institute_id) then
    raise exception 'paste the access token' using errcode = '22023';
  end if;
  insert into public.whatsapp_accounts (institute_id, phone_number_id, waba_id, display_name, display_phone,
                                        status, token_source, last_error, connected_by, connected_at)
    values (seat.institute_id, p_phone_number_id, p_waba_id, trim(p_display_name), p_display_phone,
            'connected', coalesce(p_token_source, 'stored'), null, p_user, now())
    on conflict (institute_id) do update set
      phone_number_id = excluded.phone_number_id, waba_id = excluded.waba_id,
      display_name = excluded.display_name, display_phone = excluded.display_phone, status = 'connected',
      token_source = excluded.token_source, last_error = null, connected_by = excluded.connected_by,
      connected_at = now();
  if p_token_source = 'platform' then
    delete from public.whatsapp_secrets where institute_id = seat.institute_id;
  elsif p_token_cipher is not null then
    insert into public.whatsapp_secrets (institute_id, token_cipher) values (seat.institute_id, p_token_cipher)
      on conflict (institute_id) do update set token_cipher = excluded.token_cipher, updated_at = now();
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, p_user, 'whatsapp.connected', p_phone_number_id);
end $$;

-- Switch WhatsApp off for the owner's institute and delete the stored token.
create or replace function public.wa_disconnect(p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
begin
  seat := public.wa_seat_of(p_user);
  if seat.id is null or seat.role <> 'admin' or seat.admin_kind <> 'owner' then
    raise exception 'only an owner can disconnect WhatsApp' using errcode = '42501';
  end if;
  update public.whatsapp_accounts set status = 'disconnected' where institute_id = seat.institute_id;
  delete from public.whatsapp_secrets where institute_id = seat.institute_id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, p_user, 'whatsapp.disconnected', seat.institute_id::text);
end $$;

-- Marks an account as broken (Meta refused the token), so sending stops until an owner connects again.
create or replace function public.wa_account_error(p_institute uuid, p_error text)
returns void
language sql security definer set search_path = public
as $$
  update public.whatsapp_accounts set status = 'error', last_error = left(p_error, 300)
  where institute_id = p_institute and status = 'connected';
$$;

-- Records what Meta said about a template: after "Submit for approval" (by our id), after a status check or
-- from the webhook (by name within the business account p_waba_id, or by Meta template id alone).
-- Returns the number of rows changed.
create or replace function public.wa_template_status(p_template uuid, p_waba_id text, p_meta_name text,
  p_meta_template_id text, p_status text, p_reason text default null)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  st  text := lower(coalesce(p_status, ''));
  cnt int;
begin
  st := case st when 'approved' then 'approved' when 'pending' then 'pending' when 'in_appeal' then 'pending'
                when 'rejected' then 'rejected' when 'paused' then 'paused' when 'disabled' then 'disabled'
                when 'pending_deletion' then 'disabled' when 'deleted' then 'disabled'
                when 'flagged' then 'approved' when 'reinstated' then 'approved' else null end;
  if st is null then raise exception 'unknown template status %', p_status using errcode = '22023'; end if;
  update public.whatsapp_templates t set
      meta_status = st,
      meta_reason = case when st in ('rejected', 'paused', 'disabled') then left(nullif(p_reason, 'NONE'), 300) end,
      meta_template_id = coalesce(p_meta_template_id, t.meta_template_id),
      submitted_at = case when st = 'pending' and t.meta_status <> 'pending' then now() else t.submitted_at end
    where (p_template is not null and t.id = p_template)
       or (p_template is null and p_meta_name is not null and t.meta_name = p_meta_name
           and t.institute_id in (select a.institute_id from public.whatsapp_accounts a where a.waba_id = p_waba_id))
       or (p_template is null and p_meta_name is null and p_meta_template_id is not null
           and t.meta_template_id = p_meta_template_id);
  get diagnostics cnt = row_count;
  if p_template is not null and cnt > 0 then
    insert into public.audit_log (institute_id, actor_id, action, target)
      select t.institute_id, null, 'whatsapp.template_' || st, t.key from public.whatsapp_templates t where t.id = p_template;
  end if;
  return cnt;
end $$;

-- A template and its account for "Submit for approval" or a status check, for an admin of its institute.
create or replace function public.wa_template_for_admin(p_user uuid, p_template uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
  t    public.whatsapp_templates;
begin
  seat := public.wa_seat_of(p_user);
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can submit templates' using errcode = '42501';
  end if;
  select * into t from public.whatsapp_templates where id = p_template and institute_id = seat.institute_id;
  if t.id is null then raise exception 'template not found' using errcode = '22023'; end if;
  return to_jsonb(t);
end $$;

-- Claims one send: checks everything, writes a 'queued' message and returns what the Edge Function needs
-- (the lead's number and fields, amounts for the template, the template and the account). The caller's seat
-- must have the lead assigned; the lead must have WhatsApp consent and not be "do not call"; the template
-- must be approved. The same template to the same lead goes at most once a day (India time); a failed send
-- can be tried again.
create or replace function public.wa_prepare_send(p_user uuid, p_lead uuid, p_template_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  l    public.leads;
  t    public.whatsapp_templates;
  acc  public.whatsapp_accounts;
  mid  uuid;
  dkey text;
begin
  seat := public.wa_seat_of(p_user);
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  select * into l from public.leads where id = p_lead;
  if l.id is null or l.assigned_seat_id is distinct from seat.id then
    raise exception 'this lead is not assigned to you' using errcode = '42501';
  end if;
  if l.do_not_call or l.status = 'do_not_call' then
    raise exception 'this person asked not to be contacted' using errcode = '22023';
  end if;
  if not l.consent_whatsapp then
    raise exception 'this person has not agreed to WhatsApp messages' using errcode = '22023';
  end if;
  select * into acc from public.whatsapp_accounts where institute_id = l.institute_id;
  if acc.institute_id is null or acc.status <> 'connected' then
    raise exception 'WhatsApp is not connected for your institute' using errcode = '22023';
  end if;
  select * into t from public.whatsapp_templates where institute_id = l.institute_id and key = p_template_key;
  if t.id is null or t.meta_status <> 'approved' or t.key = 'weekly_brief' then
    raise exception 'this message is not approved by WhatsApp yet' using errcode = '22023';
  end if;
  dkey := 'after_call:' || l.id || ':' || t.key || ':' || (now() at time zone 'Asia/Kolkata')::date;
  insert into public.whatsapp_messages (institute_id, lead_id, seat_id, template_id, template_key, direction, kind,
                                        status, category, dedupe_key)
    values (l.institute_id, l.id, seat.id, t.id, t.key, 'out', 'after_call', 'queued', t.category, dkey)
    on conflict (institute_id, dedupe_key) do update set status = 'queued', error = null, status_at = now(),
                                                         seat_id = excluded.seat_id
      where whatsapp_messages.status = 'failed'
    returning id into mid;
  if mid is null then
    raise exception 'this message was already sent to this person today' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'message_id', mid, 'institute_id', l.institute_id, 'seat_id', seat.id, 'caller_name', seat.label,
    'institute_name', (select i.name from public.institutes i where i.id = l.institute_id),
    'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'amount_due', l.amount_due,
                               'promised_amount', l.promised_amount, 'promised_date', l.promised_date),
    'template', jsonb_build_object('id', t.id, 'key', t.key, 'meta_name', t.meta_name, 'language', t.language,
                                   'category', t.category, 'body', t.body, 'param_sources', to_jsonb(t.param_sources)),
    'account', jsonb_build_object('phone_number_id', acc.phone_number_id, 'token_source', acc.token_source),
    'token_cipher', (select s.token_cipher from public.whatsapp_secrets s where s.institute_id = l.institute_id));
end $$;

-- After the Graph API call: 'sent' with Meta's message id, or 'failed' with the reason. Sets the estimated
-- cost of a sent message. p_body is the text with amounts masked.
create or replace function public.wa_mark_message(p_id uuid, p_status text, p_meta_id text, p_body text,
  p_error text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'status must be sent or failed' using errcode = '22023';
  end if;
  update public.whatsapp_messages set
      status = p_status, meta_message_id = coalesce(p_meta_id, meta_message_id), body = left(p_body, 4096),
      error = case when p_status = 'failed' then left(coalesce(p_error, 'failed'), 300) end,
      cost_inr = case when p_status = 'sent' then public.wa_rate(category) else 0 end,
      status_at = now()
    where id = p_id;
end $$;

-- A status from the webhook. Moves forward only (sent → delivered → read); 'failed' wins unless the message
-- was already read. A failed message costs nothing. Returns false when the message is not ours.
create or replace function public.wa_status_update(p_meta_id text, p_status text, p_at timestamptz,
  p_error text default null)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  m    public.whatsapp_messages;
  rank_old int;
  rank_new int;
begin
  select * into m from public.whatsapp_messages where meta_message_id = p_meta_id and direction = 'out';
  if m.id is null then return false; end if;
  rank_old := array_position(array['queued', 'sent', 'delivered', 'read'], m.status);
  rank_new := array_position(array['queued', 'sent', 'delivered', 'read'], p_status);
  if p_status = 'failed' then
    if m.status <> 'read' then
      update public.whatsapp_messages set status = 'failed', error = left(coalesce(p_error, 'failed'), 300),
                                          cost_inr = 0, status_at = coalesce(p_at, now())
        where id = m.id;
    end if;
  elsif rank_new is not null and (m.status = 'failed' or rank_new > coalesce(rank_old, 0)) and m.status <> 'read' then
    update public.whatsapp_messages set status = p_status, status_at = coalesce(p_at, now()),
                                        cost_inr = case when m.status = 'failed' then public.wa_rate(category) else cost_inr end,
                                        error = null
      where id = m.id;
  end if;
  return true;
end $$;

-- A reply from a person. Found by the business number (phone_number_id) and the sender's number. Stored on
-- the lead that last got a message from this institute (else the most recently changed lead with that number).
-- p_is_stop (the webhook decides: STOP, "band karo" …) turns WhatsApp consent off on every lead of the
-- institute with that number. The same Meta message id is stored once.
create or replace function public.wa_store_reply(p_phone_number_id text, p_from text, p_meta_id text,
  p_body text, p_is_stop boolean, p_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  inst    uuid;
  v_phone text := public.normalise_phone(p_from);
  lead    uuid;
  mid     uuid;
  stopped int := 0;
begin
  select a.institute_id into inst from public.whatsapp_accounts a where a.phone_number_id = p_phone_number_id;
  if inst is null then return jsonb_build_object('stored', false, 'reason', 'unknown number'); end if;
  if v_phone is not null then
    select m.lead_id into lead from public.whatsapp_messages m join public.leads l on l.id = m.lead_id
      where m.institute_id = inst and m.direction = 'out' and l.phone = v_phone
      order by m.created_at desc limit 1;
    if lead is null then
      select l.id into lead from public.leads l where l.institute_id = inst and l.phone = v_phone
        order by l.updated_at desc limit 1;
    end if;
  end if;
  insert into public.whatsapp_messages (institute_id, lead_id, direction, kind, status, meta_message_id, body,
                                        is_stop, created_at, status_at)
    values (inst, lead, 'in', 'reply', 'received', p_meta_id, left(p_body, 4096), coalesce(p_is_stop, false),
            coalesce(p_at, now()), coalesce(p_at, now()))
    on conflict (meta_message_id) do nothing
    returning id into mid;
  if mid is not null and p_is_stop and v_phone is not null then
    update public.leads set consent_whatsapp = false
      where institute_id = inst and phone = v_phone and consent_whatsapp;
    get diagnostics stopped = row_count;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (inst, null, 'whatsapp.stopped', coalesce(lead::text, 'unknown lead'));
  end if;
  return jsonb_build_object('stored', mid is not null, 'lead_id', lead, 'stopped', stopped);
end $$;

-- The reminders due today: leads with a promise on p_today + 1, WhatsApp consent, not "do not call", in an
-- institute with a connected number and an approved utility template 'promise_due'. Each is claimed with a
-- 'queued' message whose dedupe key is the lead and the promised date, so a reminder never goes twice
-- (a failed one is tried again on the next run). Returns one row per claimed reminder.
create or replace function public.wa_claim_reminders(p_today date, p_limit int default 500)
returns setof jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r   record;
  mid uuid;
begin
  for r in
    select l.id as lead_id, l.institute_id, l.name, l.phone, l.amount_due, l.promised_amount, l.promised_date,
           i.name as institute_name, t.id as template_id, t.key, t.meta_name, t.language, t.category, t.body,
           t.param_sources, a.phone_number_id, a.token_source,
           (select s.token_cipher from public.whatsapp_secrets s where s.institute_id = l.institute_id) as token_cipher
    from public.leads l
    join public.institutes i on i.id = l.institute_id and i.status in ('trial', 'active', 'grace')
    join public.whatsapp_accounts a on a.institute_id = l.institute_id and a.status = 'connected'
    join public.whatsapp_templates t on t.institute_id = l.institute_id and t.key = 'promise_due'
                                    and t.meta_status = 'approved' and t.category = 'utility'
    join public.campaigns c on c.id = l.campaign_id and c.status in ('running', 'paused')
    where l.status = 'promised' and l.promised_date = p_today + 1 and l.consent_whatsapp and not l.do_not_call
    order by l.institute_id, l.id
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    mid := null;
    insert into public.whatsapp_messages (institute_id, lead_id, template_id, template_key, direction, kind,
                                          status, category, dedupe_key)
      values (r.institute_id, r.lead_id, r.template_id, r.key, 'out', 'reminder', 'queued', r.category,
              'reminder:' || r.lead_id || ':' || r.promised_date)
      on conflict (institute_id, dedupe_key) do update set status = 'queued', error = null, status_at = now()
        where whatsapp_messages.status = 'failed'
      returning id into mid;
    continue when mid is null;
    return next jsonb_build_object(
      'message_id', mid, 'institute_id', r.institute_id, 'institute_name', r.institute_name, 'caller_name', null,
      'lead', jsonb_build_object('id', r.lead_id, 'name', r.name, 'phone', r.phone, 'amount_due', r.amount_due,
                                 'promised_amount', r.promised_amount, 'promised_date', r.promised_date),
      'template', jsonb_build_object('id', r.template_id, 'key', r.key, 'meta_name', r.meta_name,
                                     'language', r.language, 'category', r.category, 'body', r.body,
                                     'param_sources', to_jsonb(r.param_sources)),
      'account', jsonb_build_object('phone_number_id', r.phone_number_id, 'token_source', r.token_source),
      'token_cipher', r.token_cipher);
  end loop;
end $$;

-- True when the database has admin_weekly_brief(uuid) (built by the Insights feature).
create or replace function public.wa_brief_available()
returns boolean
language sql stable
as $$
  select to_regprocedure('public.admin_weekly_brief(uuid)') is not null;
$$;

-- The weekly brief for every owner who asked for it on WhatsApp: one row per owner and running campaign,
-- claimed once per week (p_week = the Monday). The lines come from admin_weekly_brief(campaign), run as that
-- owner (it checks admin rights with auth.uid(), and money with can_see_money(), so the brief shows exactly
-- what the owner would see on Insights). Without admin_weekly_brief nothing is returned.
create or replace function public.wa_claim_briefs(p_week date)
returns setof jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r      record;
  lines  jsonb;
  mid    uuid;
  old_claims text;
  old_sub    text;
begin
  if not public.wa_brief_available() then return; end if;
  old_claims := current_setting('request.jwt.claims', true);
  old_sub := current_setting('request.jwt.claim.sub', true);
  for r in
    select b.seat_id, b.phone, s.user_id, s.institute_id, i.name as institute_name, c.id as campaign_id,
           c.name as campaign_name,
           t.id as template_id, t.key, t.meta_name, t.language, t.category, t.body, t.param_sources,
           a.phone_number_id, a.token_source,
           (select x.token_cipher from public.whatsapp_secrets x where x.institute_id = s.institute_id) as token_cipher
    from public.whatsapp_brief_recipients b
    join public.seats s on s.id = b.seat_id and s.status = 'active' and s.role = 'admin' and s.admin_kind = 'owner'
    join public.institutes i on i.id = s.institute_id and i.status in ('trial', 'active', 'grace')
    join public.whatsapp_accounts a on a.institute_id = s.institute_id and a.status = 'connected'
    join public.whatsapp_templates t on t.institute_id = s.institute_id and t.key = 'weekly_brief'
                                    and t.meta_status = 'approved'
    join public.campaigns c on c.institute_id = s.institute_id and c.status = 'running'
    order by s.institute_id, b.seat_id, c.name
  loop
    begin
      perform set_config('request.jwt.claims', jsonb_build_object('sub', r.user_id, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', r.user_id::text, true);
      execute 'select coalesce(jsonb_agg(to_jsonb(b)), ''[]''::jsonb) from public.admin_weekly_brief($1) b'
        into lines using r.campaign_id;
    exception when others then
      lines := null;
    end;
    perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    continue when lines is null or lines = '[]'::jsonb;
    mid := null;
    insert into public.whatsapp_messages (institute_id, seat_id, template_id, template_key, direction, kind, status,
                                          category, dedupe_key)
      values (r.institute_id, r.seat_id, r.template_id, r.key, 'out', 'brief', 'queued', r.category,
              'brief:' || r.seat_id || ':' || r.campaign_id || ':' || p_week)
      on conflict (institute_id, dedupe_key) do update set status = 'queued', error = null, status_at = now()
        where whatsapp_messages.status = 'failed'
      returning id into mid;
    continue when mid is null;
    return next jsonb_build_object(
      'message_id', mid, 'institute_id', r.institute_id, 'institute_name', r.institute_name, 'phone', r.phone,
      'campaign_name', r.campaign_name,
      'lines', lines,
      'template', jsonb_build_object('id', r.template_id, 'key', r.key, 'meta_name', r.meta_name,
                                     'language', r.language, 'category', r.category, 'body', r.body,
                                     'param_sources', to_jsonb(r.param_sources)),
      'account', jsonb_build_object('phone_number_id', r.phone_number_id, 'token_source', r.token_source),
      'token_cipher', r.token_cipher);
  end loop;
end $$;

-- ---------- grants ----------

revoke all on function public.wa_rate(text) from public, anon;
revoke all on function public.wa_body_params(text) from public, anon;
revoke all on function public.wa_month_start() from public, anon, authenticated;
revoke all on function public.wa_seat_of(uuid) from public, anon, authenticated;
revoke all on function public.admin_whatsapp_overview() from public, anon;
revoke all on function public.admin_whatsapp_save_template(uuid, text, text, text, text, text, text, text, text[]) from public, anon;
revoke all on function public.admin_whatsapp_delete_template(uuid) from public, anon;
revoke all on function public.admin_whatsapp_brief(boolean, text) from public, anon;
revoke all on function public.my_whatsapp_templates() from public, anon;
grant execute on function public.wa_rate(text) to authenticated;
grant execute on function public.wa_body_params(text) to authenticated;
grant execute on function public.admin_whatsapp_overview() to authenticated;
grant execute on function public.admin_whatsapp_save_template(uuid, text, text, text, text, text, text, text, text[]) to authenticated;
grant execute on function public.admin_whatsapp_delete_template(uuid) to authenticated;
grant execute on function public.admin_whatsapp_brief(boolean, text) to authenticated;
grant execute on function public.my_whatsapp_templates() to authenticated;

-- The Edge Functions call these with the service role key. Nobody else may.
revoke all on function public.wa_admin_context(uuid) from public, anon, authenticated;
revoke all on function public.wa_connect(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_disconnect(uuid) from public, anon, authenticated;
revoke all on function public.wa_account_error(uuid, text) from public, anon, authenticated;
revoke all on function public.wa_template_status(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_template_for_admin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wa_prepare_send(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.wa_mark_message(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.wa_status_update(text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.wa_store_reply(text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.wa_claim_reminders(date, int) from public, anon, authenticated;
revoke all on function public.wa_brief_available() from public, anon, authenticated;
revoke all on function public.wa_claim_briefs(date) from public, anon, authenticated;
grant execute on function public.wa_admin_context(uuid) to service_role;
grant execute on function public.wa_connect(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.wa_disconnect(uuid) to service_role;
grant execute on function public.wa_account_error(uuid, text) to service_role;
grant execute on function public.wa_template_status(uuid, text, text, text, text, text) to service_role;
grant execute on function public.wa_template_for_admin(uuid, uuid) to service_role;
grant execute on function public.wa_prepare_send(uuid, uuid, text) to service_role;
grant execute on function public.wa_mark_message(uuid, text, text, text, text) to service_role;
grant execute on function public.wa_status_update(text, text, timestamptz, text) to service_role;
grant execute on function public.wa_store_reply(text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.wa_claim_reminders(date, int) to service_role;
grant execute on function public.wa_brief_available() to service_role;
grant execute on function public.wa_claim_briefs(date) to service_role;
