-- Automações do Instagram: comentário em post, Reels e live, Direct, resposta e menção em Story,
-- respondidos sozinhos no Direct pela API oficial da Meta, no seu próprio Supabase.
--
--   * tabelas no esquema privado instagram_automations, fora da API pública;
--   * a chave da Página e a chave secreta do app da Meta no Vault (cofre criptografado);
--   * um agendador (pg_cron) que acorda a função "automacoes" a cada minuto para buscar comentários novos,
--     processar eventos e enviar a fila.
--
-- As funções public.instagram_automations_* só aceitam a chave secreta do projeto (service_role).
-- O arquivo pode ser aplicado mais de uma vez: nada é apagado e nada é duplicado.

create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    create extension supabase_vault;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    create extension pg_net with schema extensions;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
end;
$$;

create schema if not exists instagram_automations;
revoke all on schema instagram_automations from public;

-- 1. Conta conectada. A chave da Página fica no Vault com o nome instagram_automations_token_<id>.
create table if not exists instagram_automations.accounts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null unique check (account_key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  expected_username text check (expected_username ~ '^[a-z0-9_.]{1,30}$'),
  page_id text check (page_id ~ '^[0-9]{5,40}$'),
  ig_user_id text unique check (ig_user_id ~ '^[0-9]{5,40}$'),
  username text check (username ~ '^[A-Za-z0-9_.]{1,30}$'),
  scopes text[] not null default '{}',
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'expired')),
  subscribed_at timestamptz,
  last_error text check (length(last_error) <= 300),
  connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists instagram_automations.oauth_requests (
  state text primary key check (state ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists oauth_requests_account_idx on instagram_automations.oauth_requests (account_id);

create table if not exists instagram_automations.pending_tokens (
  account_id uuid primary key references instagram_automations.accounts(id) on delete cascade,
  scopes text[] not null,
  created_at timestamptz not null default now()
);

-- 2. Automações. "draft" é o que o quadro edita; "published" é a versão que atende (só muda ao publicar).
create table if not exists instagram_automations.automations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  draft jsonb not null check (jsonb_typeof(draft) = 'object'),
  published jsonb check (published is null or jsonb_typeof(published) = 'object'),
  mode text not null default 'off' check (mode in ('off', 'test', 'live')),
  test_recipients text[] not null default '{}' check (cardinality(test_recipients) <= 5),
  activated_at timestamptz,
  archived_at timestamptz,
  revision integer not null default 1,
  published_revision integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode = 'off' or published is not null),
  check (mode <> 'test' or cardinality(test_recipients) between 1 and 5)
);
create index if not exists automations_account_idx on instagram_automations.automations (account_id);

-- 3. Contatos (um por pessoa que interagiu) e mensagens.
create table if not exists instagram_automations.contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  igsid text not null check (igsid ~ '^[0-9]{5,40}$'),
  username text check (username ~ '^[A-Za-z0-9_.]{1,30}$'),
  name text check (length(name) <= 120),
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  preview text check (length(preview) <= 240),
  automation_paused boolean not null default false,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, igsid)
);

create table if not exists instagram_automations.events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  key text not null check (length(key) <= 200),
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  lease_until timestamptz,
  attempts integer not null default 0,
  error text check (length(error) <= 300),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (account_id, key)
);
create index if not exists events_pending_idx on instagram_automations.events (created_at) where status in ('pending', 'processing');

create table if not exists instagram_automations.runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  contact_id uuid not null references instagram_automations.contacts(id) on delete cascade,
  automation_id uuid not null references instagram_automations.automations(id) on delete cascade,
  event_id uuid references instagram_automations.events(id) on delete set null,
  nodes jsonb not null check (jsonb_typeof(nodes) = 'array'),
  next_index integer not null default 0,
  comment_id text check (comment_id ~ '^[0-9]{5,40}$'),
  media_id text check (media_id ~ '^[0-9]{5,40}$'),
  live boolean not null default false,
  status text not null default 'ready'
    check (status in ('ready', 'sending', 'waiting', 'done', 'expired', 'paused', 'failed', 'uncertain', 'cancelled')),
  waiting_hash text,
  waiting_label text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists runs_contact_idx on instagram_automations.runs (contact_id, created_at desc);
create index if not exists runs_automation_idx on instagram_automations.runs (automation_id);
create index if not exists runs_account_idx on instagram_automations.runs (account_id);
create index if not exists runs_event_idx on instagram_automations.runs (event_id);

create table if not exists instagram_automations.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  contact_id uuid not null references instagram_automations.contacts(id) on delete cascade,
  run_id uuid references instagram_automations.runs(id) on delete set null,
  automation_id uuid references instagram_automations.automations(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null check (kind in ('comment', 'direct', 'story_reply', 'story_mention', 'postback', 'echo',
    'private_reply', 'text', 'public_reply', 'manual')),
  text text not null default '' check (length(text) <= 4000),
  provider_id text check (length(provider_id) <= 1000),
  request_key text check (length(request_key) <= 200),
  payload jsonb,
  status text not null check (status in ('received', 'queued', 'sending', 'accepted', 'read', 'unknown', 'failed',
    'cancelled', 'deleted')),
  automated boolean not null default false,
  error text check (length(error) <= 300),
  lease_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (account_id, request_key)
);
create unique index if not exists messages_provider_idx on instagram_automations.messages (account_id, direction, provider_id)
  where provider_id is not null;
create index if not exists messages_contact_idx on instagram_automations.messages (contact_id, created_at desc);
create index if not exists messages_queue_idx on instagram_automations.messages (created_at) where status in ('queued', 'sending');
create index if not exists messages_automation_idx on instagram_automations.messages (automation_id, created_at desc);
create index if not exists messages_run_idx on instagram_automations.messages (run_id);

-- 4. Links rastreados (cada botão de link tem seu próprio código) e cliques.
create table if not exists instagram_automations.links (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  message_id uuid not null references instagram_automations.messages(id) on delete cascade,
  automation_id uuid references instagram_automations.automations(id) on delete set null,
  destination text not null check (destination ~ '^https://'),
  created_at timestamptz not null default now()
);
create table if not exists instagram_automations.link_clicks (
  id bigserial primary key,
  token_hash text not null references instagram_automations.links(token_hash) on delete cascade,
  clicked_at timestamptz not null default now()
);
create index if not exists links_message_idx on instagram_automations.links (message_id);
create index if not exists links_automation_idx on instagram_automations.links (automation_id);
create index if not exists link_clicks_token_idx on instagram_automations.link_clicks (token_hash);

-- 5. Até onde já lemos os comentários de cada publicação (a busca roda a cada minuto).
create table if not exists instagram_automations.comment_cursors (
  media_id text primary key check (media_id ~ '^[0-9]{5,40}$'),
  account_id uuid not null references instagram_automations.accounts(id) on delete cascade,
  newest_comment_at timestamptz,
  checked_at timestamptz not null default now()
);
create index if not exists comment_cursors_account_idx on instagram_automations.comment_cursors (account_id);

revoke all on all tables in schema instagram_automations from public;

-- 6. Cofre.
create or replace function instagram_automations.put_secret(p_name text, p_value text, p_description text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_value, p_name, p_description);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
  return v_id;
end;
$$;

create or replace function instagram_automations.read_secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = p_name limit 1;
$$;

create or replace function instagram_automations.drop_secret(p_name text)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets s where s.name = p_name;
$$;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'instagram_automations_cron_secret',
  'Chamada do agendador para a função automacoes')
where not exists (select 1 from vault.secrets where name = 'instagram_automations_cron_secret');
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'instagram_automations_verify_token',
  'Token de verificação do webhook, colado no app da Meta')
where not exists (select 1 from vault.secrets where name = 'instagram_automations_verify_token');

create or replace function instagram_automations.account_by_key(p_account_key text)
returns instagram_automations.accounts language sql stable security definer set search_path = '' as $$
  select a.* from instagram_automations.accounts a
  where a.account_key = lower(trim(coalesce(p_account_key, 'principal')));
$$;

-- 7. Configuração e estado.
create or replace function public.instagram_automations_configure(
  p_project_url text, p_app_id text, p_app_secret text, p_config_id text, p_graph_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_project_url, '') !~ '^https://[a-z0-9.-]+$' then raise exception 'Endereço do projeto inválido.'; end if;
  perform instagram_automations.put_secret('instagram_automations_project_url', p_project_url, 'Endereço do projeto');
  if p_app_id is not null then
    if p_app_id !~ '^[0-9]{5,30}$' then raise exception 'O ID do app da Meta tem só números.'; end if;
    if coalesce(p_config_id, '') !~ '^[0-9]{5,30}$' then raise exception 'O ID da configuração do login tem só números.'; end if;
    if coalesce(p_app_secret, '') !~* '^[0-9a-f]{32}$' then raise exception 'A chave secreta do app da Meta tem 32 letras e números.'; end if;
    if coalesce(p_graph_version, '') !~ '^v[0-9]{2}\.[0-9]$' then raise exception 'Versão da API da Meta inválida (exemplo: v26.0).'; end if;
    perform instagram_automations.put_secret('instagram_automations_meta_app_id', p_app_id, 'ID do app da Meta');
    perform instagram_automations.put_secret('instagram_automations_meta_app_secret', p_app_secret, 'Chave secreta do app da Meta');
    perform instagram_automations.put_secret('instagram_automations_meta_config_id', p_config_id, 'ID da configuração do login');
    perform instagram_automations.put_secret('instagram_automations_meta_graph_version', p_graph_version, 'Versão da API da Meta');
  end if;
  return jsonb_build_object('meta_configured', instagram_automations.read_secret('instagram_automations_meta_app_secret') is not null,
    'verify_token', instagram_automations.read_secret('instagram_automations_verify_token'));
end;
$$;

create or replace function public.instagram_automations_meta_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'app_id', instagram_automations.read_secret('instagram_automations_meta_app_id'),
    'app_secret', instagram_automations.read_secret('instagram_automations_meta_app_secret'),
    'config_id', instagram_automations.read_secret('instagram_automations_meta_config_id'),
    'graph_version', coalesce(instagram_automations.read_secret('instagram_automations_meta_graph_version'), 'v26.0'),
    'verify_token', instagram_automations.read_secret('instagram_automations_verify_token'));
$$;

create or replace function public.instagram_automations_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'meta_configured', instagram_automations.read_secret('instagram_automations_meta_app_secret') is not null,
    'scheduler_ready', instagram_automations.read_secret('instagram_automations_project_url') is not null
      and exists (select 1 from cron.job j where j.jobname = 'instagram-automations' and j.active),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('account', a.account_key, 'username', a.username,
        'expected_username', a.expected_username, 'status', a.status, 'connected_at', a.connected_at,
        'subscribed', a.subscribed_at is not null, 'last_error', a.last_error,
        'pending', exists (select 1 from instagram_automations.pending_tokens t where t.account_id = a.id),
        'pending_at', (select t.created_at from instagram_automations.pending_tokens t where t.account_id = a.id))
      order by a.created_at) from instagram_automations.accounts a), '[]'::jsonb),
    'automations', jsonb_build_object(
      'live', (select count(*) from instagram_automations.automations where mode = 'live' and archived_at is null),
      'test', (select count(*) from instagram_automations.automations where mode = 'test' and archived_at is null),
      'off', (select count(*) from instagram_automations.automations where mode = 'off' and archived_at is null)),
    'last_event_at', (select max(created_at) from instagram_automations.events),
    'queue', (select count(*) from instagram_automations.messages where status in ('queued', 'sending')));
$$;

-- 8. Conexão pela Página (login do Facebook para Empresas).
create or replace function public.instagram_automations_oauth_begin(p_account_key text, p_expected_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := lower(trim(coalesce(p_account_key, 'principal')));
  v_expected text := nullif(lower(ltrim(trim(coalesce(p_expected_username, '')), '@')), '');
  v_account instagram_automations.accounts;
  v_state text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into instagram_automations.accounts as a (account_key, expected_username) values (v_key, v_expected)
  on conflict (account_key) do update set expected_username = coalesce(excluded.expected_username, a.expected_username)
  returning * into v_account;
  delete from instagram_automations.oauth_requests r where r.expires_at < now() or r.account_id = v_account.id;
  insert into instagram_automations.oauth_requests (state, account_id, expires_at)
  values (v_state, v_account.id, now() + interval '30 minutes');
  return jsonb_build_object('state', v_state, 'account', v_account.account_key, 'expected_username', v_account.expected_username);
end;
$$;

create or replace function public.instagram_automations_oauth_consume(p_state text)
returns jsonb language sql security definer set search_path = '' as $$
  with used as (
    delete from instagram_automations.oauth_requests r where r.state = p_state and r.expires_at > now()
    returning r.account_id
  )
  select jsonb_build_object('account_id', a.id, 'account', a.account_key, 'expected_username', a.expected_username)
  from used join instagram_automations.accounts a on a.id = used.account_id;
$$;

create or replace function public.instagram_automations_save_connection(
  p_account uuid, p_page_id text, p_ig_user_id text, p_username text, p_token text, p_scopes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_automations.accounts;
begin
  select * into v_account from instagram_automations.accounts a where a.id = p_account for update;
  if not found then raise exception 'account_not_found'; end if;
  if v_account.expected_username is not null and v_account.expected_username <> lower(p_username) then
    raise exception 'username_mismatch';
  end if;
  if exists (select 1 from instagram_automations.accounts a where a.ig_user_id = p_ig_user_id and a.id <> p_account) then
    raise exception 'instagram_in_use';
  end if;
  if not (coalesce(p_scopes, '{}') @> array['instagram_manage_messages', 'instagram_manage_comments', 'pages_messaging']) then
    raise exception 'missing_scopes';
  end if;
  if p_token is null or length(p_token) < 20 or coalesce(p_page_id, '') !~ '^[0-9]{5,40}$' then raise exception 'invalid_token'; end if;
  perform instagram_automations.put_secret('instagram_automations_token_' || p_account::text, p_token, 'Chave da Página');
  update instagram_automations.accounts set page_id = p_page_id, ig_user_id = p_ig_user_id, username = p_username,
    scopes = p_scopes, status = 'connected', connected_at = now(), subscribed_at = null, last_error = null,
    expected_username = coalesce(expected_username, lower(p_username))
  where id = p_account;
  delete from instagram_automations.pending_tokens t where t.account_id = p_account;
  perform instagram_automations.drop_secret('instagram_automations_pending_' || p_account::text);
  return jsonb_build_object('account', v_account.account_key, 'username', p_username);
end;
$$;

create or replace function public.instagram_automations_mark_subscribed(p_account uuid, p_ok boolean, p_error text)
returns void language sql security definer set search_path = '' as $$
  update instagram_automations.accounts set subscribed_at = case when p_ok then now() else null end,
    last_error = case when p_ok then null else left(p_error, 300) end
  where id = p_account;
$$;

create or replace function public.instagram_automations_keep_pending(p_account uuid, p_token text, p_scopes text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_token is null or length(p_token) < 20 then raise exception 'invalid_token'; end if;
  perform instagram_automations.put_secret('instagram_automations_pending_' || p_account::text, p_token, 'Chave aguardando a Página certa');
  insert into instagram_automations.pending_tokens as t (account_id, scopes) values (p_account, coalesce(p_scopes, '{}'))
  on conflict (account_id) do update set scopes = excluded.scopes, created_at = now();
end;
$$;

create or replace function public.instagram_automations_take_pending(p_account_key text, p_expected_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_automations.accounts := instagram_automations.account_by_key(p_account_key);
  v_expected text := nullif(lower(ltrim(trim(coalesce(p_expected_username, '')), '@')), '');
  v_pending instagram_automations.pending_tokens;
begin
  if v_account.id is null then return null; end if;
  select * into v_pending from instagram_automations.pending_tokens t where t.account_id = v_account.id;
  if not found then return null; end if;
  if v_expected is not null then
    update instagram_automations.accounts set expected_username = v_expected where id = v_account.id;
    v_account.expected_username := v_expected;
  end if;
  return jsonb_build_object('account_id', v_account.id, 'account', v_account.account_key,
    'expected_username', v_account.expected_username, 'scopes', v_pending.scopes,
    'token', instagram_automations.read_secret('instagram_automations_pending_' || v_account.id::text));
end;
$$;

create or replace function public.instagram_automations_disconnect(p_account_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_automations.accounts := instagram_automations.account_by_key(p_account_key);
begin
  if v_account.id is null then raise exception 'Conta % não encontrada.', p_account_key; end if;
  update instagram_automations.accounts set status = 'disconnected', subscribed_at = null where id = v_account.id;
  update instagram_automations.automations set mode = 'off', test_recipients = '{}', updated_at = now()
  where account_id = v_account.id and mode <> 'off';
  update instagram_automations.messages set status = 'cancelled', error = 'CONEXAO_DESFEITA', lease_until = null
  where account_id = v_account.id and status = 'queued';
  delete from instagram_automations.pending_tokens t where t.account_id = v_account.id;
  perform instagram_automations.drop_secret('instagram_automations_token_' || v_account.id::text);
  perform instagram_automations.drop_secret('instagram_automations_pending_' || v_account.id::text);
  return jsonb_build_object('account', v_account.account_key, 'username', v_account.username);
end;
$$;

-- Conta com a chave, para a função falar com a Meta (quadro, busca de comentários, envio).
create or replace function public.instagram_automations_connection(p_account_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_automations.accounts := instagram_automations.account_by_key(p_account_key);
begin
  if v_account.id is null or v_account.status <> 'connected' then raise exception 'not_connected'; end if;
  return jsonb_build_object('account_id', v_account.id, 'account', v_account.account_key, 'page_id', v_account.page_id,
    'ig_user_id', v_account.ig_user_id, 'username', v_account.username, 'scopes', v_account.scopes,
    'subscribed', v_account.subscribed_at is not null,
    'token', instagram_automations.read_secret('instagram_automations_token_' || v_account.id::text));
end;
$$;

create or replace function public.instagram_automations_mark_expired(p_account uuid, p_error text)
returns void language sql security definer set search_path = '' as $$
  update instagram_automations.accounts set status = 'expired', last_error = left(p_error, 300) where id = p_account;
$$;

-- 9. Automações no quadro.
create or replace function instagram_automations.summary(p instagram_automations.automations)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'draft', p.draft, 'published', p.published, 'mode', p.mode,
    'test_recipients', p.test_recipients, 'activated_at', p.activated_at, 'archived_at', p.archived_at,
    'revision', p.revision, 'created_at', p.created_at, 'updated_at', p.updated_at,
    'published_revision', p.published_revision,
    'changed_since_publish', p.published is not null and p.published_revision is distinct from p.revision,
    'metrics', jsonb_build_object(
      'runs', (select count(*) from instagram_automations.runs r where r.automation_id = p.id),
      'contacts', (select count(distinct r.contact_id) from instagram_automations.runs r where r.automation_id = p.id),
      'sent', (select count(*) from instagram_automations.messages m where m.automation_id = p.id and m.direction = 'out'
               and m.status in ('accepted', 'read') and m.kind <> 'public_reply'),
      'with_links', (select count(distinct l.message_id) from instagram_automations.links l
               join instagram_automations.messages m on m.id = l.message_id
               where l.automation_id = p.id and m.status in ('accepted', 'read')),
      'clicked', (select count(distinct l.message_id) from instagram_automations.links l
               join instagram_automations.link_clicks c on c.token_hash = l.token_hash where l.automation_id = p.id),
      'last_run_at', (select max(r.created_at) from instagram_automations.runs r where r.automation_id = p.id)));
$$;

create or replace function public.instagram_automations_list(p_account_key text, p_archived boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(instagram_automations.summary(p) order by p.updated_at desc), '[]'::jsonb)
  from instagram_automations.automations p
  where p.account_id = (instagram_automations.account_by_key(p_account_key)).id
    and (p.archived_at is not null) = coalesce(p_archived, false);
$$;

create or replace function public.instagram_automations_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select instagram_automations.summary(p) from instagram_automations.automations p where p.id = p_id;
$$;

-- Salva o rascunho. A função valida o conteúdo antes; aqui ficam a conta, a revisão e o tamanho.
create or replace function public.instagram_automations_save(p_id uuid, p_account_key text, p_draft jsonb, p_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_automations.accounts := instagram_automations.account_by_key(p_account_key);
  v_row instagram_automations.automations;
begin
  if v_account.id is null then raise exception 'Conecte o Instagram antes (npm run conectar).'; end if;
  if jsonb_typeof(p_draft) is distinct from 'object' or octet_length(p_draft::text) > 60000 then
    raise exception 'Automação inválida ou grande demais.';
  end if;
  if p_id is null then
    insert into instagram_automations.automations (account_id, draft) values (v_account.id, p_draft) returning * into v_row;
  else
    update instagram_automations.automations set draft = p_draft, revision = revision + 1, updated_at = now()
    where id = p_id and account_id = v_account.id and revision = coalesce(p_revision, revision)
    returning * into v_row;
    if not found then raise exception 'Esta automação mudou em outra janela. Recarregue antes de salvar.'; end if;
  end if;
  return instagram_automations.summary(v_row);
end;
$$;

-- p_revision: a revisão do rascunho que foi conferido e virou p_published (evita publicar um rascunho que mudou no meio).
create or replace function public.instagram_automations_publish(p_id uuid, p_mode text, p_test_recipients text[], p_published jsonb,
  p_revision integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row instagram_automations.automations;
begin
  select * into v_row from instagram_automations.automations a where a.id = p_id for update;
  if not found then raise exception 'Automação não encontrada.'; end if;
  if v_row.archived_at is not null then raise exception 'Restaure a automação da lixeira antes de ativar.'; end if;
  if p_mode not in ('off', 'test', 'live') then raise exception 'Modo inválido.'; end if;
  if p_published is not null and p_revision is not null and p_revision <> v_row.revision then
    raise exception 'Esta automação mudou em outra janela. Recarregue antes de ativar.';
  end if;
  if p_mode <> 'off' and not exists (select 1 from instagram_automations.accounts a where a.id = v_row.account_id and a.status = 'connected') then
    raise exception 'Conecte o Instagram antes de ativar (npm run conectar).';
  end if;
  update instagram_automations.automations set
    published = coalesce(p_published, published),
    published_revision = case when p_published is not null then revision else published_revision end,
    mode = p_mode,
    test_recipients = case when p_mode = 'test' then coalesce(p_test_recipients, '{}') else '{}' end,
    activated_at = case when p_mode = 'off' then activated_at
      when mode = 'off' or p_published is not null then now() else activated_at end,
    updated_at = now()
  where id = p_id returning * into v_row;
  if p_mode = 'off' then
    update instagram_automations.runs set status = 'cancelled', updated_at = now()
    where automation_id = p_id and status in ('ready', 'waiting');
    update instagram_automations.messages set status = 'cancelled', error = 'AUTOMACAO_PAUSADA'
    where automation_id = p_id and status = 'queued';
  end if;
  return instagram_automations.summary(v_row);
end;
$$;

create or replace function public.instagram_automations_archive(p_id uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row instagram_automations.automations;
begin
  update instagram_automations.automations set archived_at = case when p_archived then now() end, updated_at = now()
  where id = p_id and (not p_archived or mode = 'off') returning * into v_row;
  if not found then raise exception 'Desligue a automação antes de mandar para a lixeira.'; end if;
  return instagram_automations.summary(v_row);
end;
$$;

-- Versões publicadas que atendem agora (teste ou ao vivo), com o que o motor precisa para decidir.
create or replace function public.instagram_automations_active(p_account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'published', a.published, 'mode', a.mode,
    'test_recipients', a.test_recipients, 'activated_at', a.activated_at) order by a.activated_at, a.id), '[]'::jsonb)
  from instagram_automations.automations a
  where a.account_id = p_account and a.mode in ('test', 'live') and a.archived_at is null and a.published is not null;
$$;

-- 10. Eventos: webhook e busca de comentários gravam aqui; o motor processa um por vez em cada conta.
create or replace function public.instagram_automations_ingest(p_ig_user_id text, p_events jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid;
  v_event jsonb;
  v_count integer := 0;
begin
  select a.id into v_account from instagram_automations.accounts a where a.ig_user_id = p_ig_user_id and a.status = 'connected';
  if v_account is null or jsonb_typeof(p_events) is distinct from 'array' then return 0; end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    insert into instagram_automations.events (account_id, key, kind, payload)
    values (v_account, left(v_event->>'key', 200), coalesce(v_event->>'kind', '?'), v_event)
    on conflict (account_id, key) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.instagram_automations_claim_event(p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event instagram_automations.events;
begin
  select e.* into v_event from instagram_automations.events e
  where ((e.status = 'pending') or (e.status = 'processing' and e.lease_until < now())) and e.attempts < 5
    and not exists (select 1 from instagram_automations.events b where b.account_id = e.account_id
      and b.status = 'processing' and b.lease_until >= now())
  order by e.created_at
  for update skip locked limit 1;
  if not found then return null; end if;
  update instagram_automations.events set status = 'processing', attempts = attempts + 1,
    lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 30))
  where id = v_event.id;
  return jsonb_build_object('id', v_event.id, 'account_id', v_event.account_id, 'event', v_event.payload,
    'received_at', v_event.created_at,
    'token', instagram_automations.read_secret('instagram_automations_token_' || v_event.account_id::text));
end;
$$;

create or replace function public.instagram_automations_finish_event(p_event uuid, p_status text, p_error text)
returns void language sql security definer set search_path = '' as $$
  update instagram_automations.events set status = case when p_status in ('done', 'failed') then p_status else 'pending' end,
    error = left(p_error, 300), lease_until = null, processed_at = now()
  where id = p_event;
$$;

-- 11. Contatos e mensagens recebidas.
create or replace function public.instagram_automations_touch_contact(
  p_account uuid, p_igsid text, p_username text, p_opens_window boolean, p_at timestamptz, p_preview text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_contact instagram_automations.contacts;
begin
  insert into instagram_automations.contacts as c (account_id, igsid, username, last_inbound_at, last_message_at, preview)
  values (p_account, p_igsid, nullif(lower(p_username), ''), case when p_opens_window then p_at end, p_at, left(p_preview, 240))
  on conflict (account_id, igsid) do update set
    username = coalesce(excluded.username, c.username),
    last_inbound_at = case when p_opens_window then greatest(coalesce(c.last_inbound_at, p_at), p_at) else c.last_inbound_at end,
    last_message_at = greatest(coalesce(c.last_message_at, p_at), p_at),
    preview = coalesce(excluded.preview, c.preview),
    updated_at = now()
  returning * into v_contact;
  return to_jsonb(v_contact);
end;
$$;

create or replace function public.instagram_automations_set_profile(p_contact uuid, p_username text, p_name text)
returns void language sql security definer set search_path = '' as $$
  update instagram_automations.contacts set username = coalesce(nullif(lower(p_username), ''), username),
    name = coalesce(nullif(left(p_name, 120), ''), name), updated_at = now()
  where id = p_contact;
$$;

-- Devolve o id da mensagem, ou null quando a mesma mensagem da Meta já foi gravada.
create or replace function public.instagram_automations_record_inbound(
  p_account uuid, p_contact uuid, p_kind text, p_text text, p_provider_id text, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into instagram_automations.messages (account_id, contact_id, direction, kind, text, provider_id, payload, status)
  values (p_account, p_contact, 'in', p_kind, left(coalesce(p_text, ''), 4000), nullif(p_provider_id, ''), p_payload, 'received')
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Eco de mensagem que não saiu daqui (alguém respondeu pelo app): pausa a automação desse contato.
create or replace function public.instagram_automations_record_echo(p_account uuid, p_contact uuid, p_text text, p_provider_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  -- O eco de uma mensagem nossa pode chegar antes de o envio ser gravado: envio recente para a pessoa conta como nosso.
  if exists (select 1 from instagram_automations.messages m where m.account_id = p_account and m.direction = 'out'
             and (m.provider_id = p_provider_id or (m.contact_id = p_contact and m.status in ('queued', 'sending', 'accepted')
               and m.created_at > now() - interval '2 minutes'))) then
    return false;
  end if;
  insert into instagram_automations.messages (account_id, contact_id, direction, kind, text, provider_id, status)
  values (p_account, p_contact, 'out', 'manual', left(coalesce(p_text, ''), 4000), p_provider_id, 'accepted')
  on conflict do nothing;
  update instagram_automations.contacts set automation_paused = true, updated_at = now() where id = p_contact;
  update instagram_automations.runs set status = 'paused', updated_at = now()
  where contact_id = p_contact and status in ('ready', 'waiting');
  return true;
end;
$$;

create or replace function public.instagram_automations_mark_message(p_account uuid, p_provider_id text, p_status text)
returns void language sql security definer set search_path = '' as $$
  update instagram_automations.messages set status = p_status,
    text = case when p_status = 'deleted' then 'Mensagem removida no Instagram.' else text end
  where account_id = p_account and provider_id = p_provider_id and p_status in ('read', 'deleted')
    and (p_status = 'deleted' or direction = 'out');
$$;

-- 12. Execuções.
create or replace function public.instagram_automations_contact_state(p_contact uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'contact', (select to_jsonb(c) from instagram_automations.contacts c where c.id = p_contact),
    'waiting', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc)
      from instagram_automations.runs r where r.contact_id = p_contact and r.status in ('waiting', 'sending', 'uncertain')
        and r.waiting_hash is not null and r.expires_at > now()), '[]'::jsonb));
$$;

-- Começa uma execução, ou devolve null se a pessoa já está numa ou passou do limite de 3 por hora.
create or replace function public.instagram_automations_start_run(p_account uuid, p_contact uuid, p_automation uuid,
  p_event uuid, p_nodes jsonb, p_comment_id text, p_media_id text, p_live boolean, p_per_automation boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run instagram_automations.runs;
begin
  perform 1 from instagram_automations.contacts c where c.id = p_contact for update;
  if exists (select 1 from instagram_automations.runs r where r.contact_id = p_contact
             and (not p_per_automation or r.automation_id = p_automation)
             and r.status in ('ready', 'sending', 'waiting') and r.expires_at > now()) then
    return null;
  end if;
  if (select count(*) from instagram_automations.runs r where r.contact_id = p_contact and r.automation_id = p_automation
      and r.created_at > now() - interval '1 hour') >= 3 then
    return null;
  end if;
  insert into instagram_automations.runs (account_id, contact_id, automation_id, event_id, nodes, comment_id, media_id, live, expires_at)
  values (p_account, p_contact, p_automation, p_event, p_nodes, p_comment_id, p_media_id, coalesce(p_live, false),
    now() + interval '7 days')
  returning * into v_run;
  return to_jsonb(v_run);
end;
$$;

-- Põe a próxima mensagem da execução na fila (uma vez por passo) junto com os links rastreados.
create or replace function public.instagram_automations_queue_step(p_run uuid, p_index integer, p_kind text, p_text text,
  p_payload jsonb, p_expires_at timestamptz, p_links jsonb, p_waiting_hash text, p_waiting_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_run instagram_automations.runs;
  v_id uuid;
  v_link jsonb;
begin
  select * into v_run from instagram_automations.runs r where r.id = p_run for update;
  if not found or v_run.status not in ('ready', 'sending') then return null; end if;
  insert into instagram_automations.messages (account_id, contact_id, run_id, automation_id, direction, kind, text,
    request_key, payload, status, automated, expires_at)
  values (v_run.account_id, v_run.contact_id, v_run.id, v_run.automation_id, 'out', p_kind, left(p_text, 4000),
    'run:' || v_run.id || ':' || p_index, p_payload, 'queued', true, p_expires_at)
  on conflict (account_id, request_key) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  for v_link in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    insert into instagram_automations.links (token_hash, message_id, automation_id, destination)
    values (v_link->>'token_hash', v_id, v_run.automation_id, v_link->>'destination');
  end loop;
  update instagram_automations.runs set status = 'sending', next_index = p_index, waiting_hash = p_waiting_hash,
    waiting_label = left(p_waiting_label, 40), updated_at = now()
  where id = p_run;
  return v_id;
end;
$$;

-- Marca etiqueta, passagem para atendimento humano, fim ou expiração.
create or replace function public.instagram_automations_run_update(p_run uuid, p_status text, p_next_index integer,
  p_tag text, p_pause_contact boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run instagram_automations.runs;
begin
  update instagram_automations.runs set status = coalesce(p_status, status), next_index = coalesce(p_next_index, next_index),
    waiting_hash = case when p_status in ('ready', 'done', 'expired', 'paused', 'failed', 'cancelled') then null else waiting_hash end,
    updated_at = now()
  where id = p_run returning * into v_run;
  if p_tag is not null then
    update instagram_automations.contacts set tags = (select array(select distinct t from unnest(tags || array[left(p_tag, 80)]) t))[1:30],
      updated_at = now() where id = v_run.contact_id;
  end if;
  if coalesce(p_pause_contact, false) then
    update instagram_automations.contacts set automation_paused = true, updated_at = now() where id = v_run.contact_id;
  end if;
  return to_jsonb(v_run);
end;
$$;

-- A pessoa tocou num botão de resposta: a execução segue pelo caminho escolhido, uma vez só.
create or replace function public.instagram_automations_choose_route(p_run uuid, p_expected_index integer, p_next_index integer,
  p_button_id text, p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run instagram_automations.runs;
begin
  update instagram_automations.runs set status = 'ready', next_index = p_next_index, waiting_hash = null, waiting_label = null,
    updated_at = now()
  where id = p_run and next_index = p_expected_index and waiting_hash is not null and status in ('waiting', 'sending', 'uncertain')
  returning * into v_run;
  if not found then return null; end if;
  update instagram_automations.messages set payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{analytics}',
      coalesce(payload->'analytics', '{}'::jsonb) || jsonb_build_object('replied_at', p_at, 'button_id', p_button_id))
  where account_id = v_run.account_id and request_key = 'run:' || v_run.id || ':' || p_expected_index;
  return to_jsonb(v_run);
end;
$$;

-- 13. Envio: uma mensagem por vez em cada conta, com tudo o que o envio precisa conferir.
create or replace function public.instagram_automations_claim_outbound(p_lease_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_message instagram_automations.messages;
  v_account instagram_automations.accounts;
begin
  select m.* into v_message from instagram_automations.messages m
  where m.direction = 'out' and m.status = 'queued'
    and not exists (select 1 from instagram_automations.messages b where b.account_id = m.account_id
      and b.status = 'sending' and b.lease_until >= now())
  order by m.created_at
  for update skip locked limit 1;
  if not found then return null; end if;
  update instagram_automations.messages set status = 'sending', lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 30))
  where id = v_message.id;
  select * into v_account from instagram_automations.accounts a where a.id = v_message.account_id;
  return jsonb_build_object(
    'message', to_jsonb(v_message),
    'contact', (select to_jsonb(c) from instagram_automations.contacts c where c.id = v_message.contact_id),
    'run', (select to_jsonb(r) from instagram_automations.runs r where r.id = v_message.run_id),
    'automation', (select jsonb_build_object('id', a.id, 'mode', a.mode, 'test_recipients', a.test_recipients,
        'published', a.published, 'activated_at', a.activated_at)
      from instagram_automations.automations a where a.id = v_message.automation_id),
    'account', jsonb_build_object('id', v_account.id, 'status', v_account.status, 'page_id', v_account.page_id,
      'ig_user_id', v_account.ig_user_id),
    'token', instagram_automations.read_secret('instagram_automations_token_' || v_account.id::text),
    'sent_last_hour', (select count(*) from instagram_automations.messages m where m.account_id = v_account.id
      and m.automated and m.status in ('accepted', 'read') and m.created_at > now() - interval '1 hour'),
    'last_public_reply', (select m.text from instagram_automations.messages m where m.automation_id = v_message.automation_id
      and m.kind = 'public_reply' and m.status in ('queued', 'sending', 'accepted') order by m.created_at desc limit 1));
end;
$$;

-- p_status: accepted | failed | unknown | cancelled. A execução segue (ready/waiting) ou para (failed/uncertain).
create or replace function public.instagram_automations_finish_outbound(p_message uuid, p_status text, p_provider_id text,
  p_error text, p_run_status text, p_next_index integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_message instagram_automations.messages;
begin
  update instagram_automations.messages set status = p_status, provider_id = coalesce(nullif(p_provider_id, ''), provider_id),
    error = left(p_error, 300), lease_until = null, sent_at = case when p_status = 'accepted' then now() else sent_at end
  where id = p_message returning * into v_message;
  if v_message.id is null then return; end if;
  if p_status = 'accepted' then
    update instagram_automations.contacts set last_message_at = now(), preview = left(v_message.text, 240), updated_at = now()
    where id = v_message.contact_id;
  end if;
  if v_message.run_id is not null and p_run_status is not null then
    update instagram_automations.runs set status = p_run_status, next_index = coalesce(p_next_index, next_index),
      waiting_hash = case when p_run_status in ('waiting', 'sending', 'uncertain') then waiting_hash end,
      updated_at = now()
    where id = v_message.run_id;
  end if;
end;
$$;

create or replace function public.instagram_automations_queue_public_reply(p_run uuid, p_text text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_run instagram_automations.runs;
  v_id uuid;
begin
  select * into v_run from instagram_automations.runs r where r.id = p_run;
  if not found or v_run.comment_id is null then return null; end if;
  insert into instagram_automations.messages (account_id, contact_id, run_id, automation_id, direction, kind, text,
    request_key, payload, status, automated, expires_at)
  values (v_run.account_id, v_run.contact_id, v_run.id, v_run.automation_id, 'out', 'public_reply', left(p_text, 1000),
    'public:' || v_run.id, jsonb_build_object('comment_id', v_run.comment_id, 'text', left(p_text, 1000)), 'queued', true,
    v_run.expires_at)
  on conflict (account_id, request_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.instagram_automations_run(p_run uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('run', to_jsonb(r), 'contact', to_jsonb(c))
  from instagram_automations.runs r join instagram_automations.contacts c on c.id = r.contact_id where r.id = p_run;
$$;

-- 14. Conversas no quadro.
create or replace function public.instagram_automations_contacts(p_account_key text, p_search text, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.last_message_at desc nulls last), '[]'::jsonb)
  from (select * from instagram_automations.contacts c
        where c.account_id = (instagram_automations.account_by_key(p_account_key)).id
          and (coalesce(p_search, '') = '' or c.igsid = p_search
               or c.username ilike '%' || p_search || '%' or c.name ilike '%' || p_search || '%')
        order by c.last_message_at desc nulls last limit least(greatest(coalesce(p_limit, 50), 1), 200)) c;
$$;

create or replace function public.instagram_automations_thread(p_contact uuid, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'contact', (select to_jsonb(c) from instagram_automations.contacts c where c.id = p_contact),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'kind', m.kind, 'text', m.text,
        'status', m.status, 'automated', m.automated, 'error', m.error, 'created_at', m.created_at) order by m.created_at)
      from (select * from instagram_automations.messages m where m.contact_id = p_contact
            order by m.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 300)) m), '[]'::jsonb));
$$;

-- Resposta manual pelo quadro: só dentro de 24 horas da última mensagem da pessoa, e pausa a automação dela.
create or replace function public.instagram_automations_queue_manual(p_contact uuid, p_text text, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_contact instagram_automations.contacts;
  v_id uuid;
begin
  select * into v_contact from instagram_automations.contacts c where c.id = p_contact for update;
  if not found then raise exception 'Contato não encontrado.'; end if;
  if v_contact.last_inbound_at is null or v_contact.last_inbound_at < now() - interval '24 hours' then
    raise exception 'A janela de 24 horas fechou: o Instagram só deixa responder depois que a pessoa escrever de novo.';
  end if;
  if length(trim(coalesce(p_text, ''))) not between 1 and 1000 then raise exception 'Mensagem vazia ou longa demais.'; end if;
  insert into instagram_automations.messages (account_id, contact_id, direction, kind, text, request_key, payload, status, expires_at)
  values (v_contact.account_id, v_contact.id, 'out', 'manual', trim(p_text), 'manual:' || p_request_id,
    jsonb_build_object('recipient', jsonb_build_object('id', v_contact.igsid), 'message', jsonb_build_object('text', trim(p_text))),
    'queued', v_contact.last_inbound_at + interval '24 hours')
  on conflict (account_id, request_key) do nothing
  returning id into v_id;
  update instagram_automations.contacts set automation_paused = true, updated_at = now() where id = p_contact;
  update instagram_automations.runs set status = 'paused', updated_at = now()
  where contact_id = p_contact and status in ('ready', 'waiting');
  return v_id;
end;
$$;

create or replace function public.instagram_automations_pause_contact(p_contact uuid, p_paused boolean)
returns jsonb language sql security definer set search_path = '' as $$
  update instagram_automations.contacts c set automation_paused = p_paused, updated_at = now() where c.id = p_contact
  returning to_jsonb(c);
$$;

-- Pedido de exclusão de dados: apaga a pessoa, a conversa, as execuções, os links enviados e os eventos recebidos dela.
create or replace function public.instagram_automations_forget_contact(p_contact uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_contact instagram_automations.contacts;
  v_messages integer;
begin
  select * into v_contact from instagram_automations.contacts c where c.id = p_contact;
  if not found then raise exception 'Contato não encontrado.'; end if;
  select count(*) into v_messages from instagram_automations.messages m where m.contact_id = p_contact;
  delete from instagram_automations.events e where e.account_id = v_contact.account_id and e.payload->>'scopedId' = v_contact.igsid;
  delete from instagram_automations.contacts c where c.id = p_contact;
  return jsonb_build_object('username', v_contact.username, 'igsid', v_contact.igsid, 'messages', v_messages);
end;
$$;

-- 15. Links rastreados: registra o clique e devolve o destino.
create or replace function public.instagram_automations_click(p_token_hash text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_destination text;
begin
  select l.destination into v_destination from instagram_automations.links l where l.token_hash = p_token_hash;
  if v_destination is null then return null; end if;
  insert into instagram_automations.link_clicks (token_hash) values (p_token_hash);
  return v_destination;
end;
$$;

-- 16. Busca de comentários: publicações a acompanhar e cursores.
create or replace function public.instagram_automations_comment_targets()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('automation_id', a.id, 'account_id', acc.id, 'ig_user_id', acc.ig_user_id,
      'page_id', acc.page_id, 'media', a.published->>'media', 'media_id', a.published->>'mediaId',
      'activated_at', a.activated_at, 'newest_comment_at', cur.newest_comment_at,
      'token', instagram_automations.read_secret('instagram_automations_token_' || acc.id::text))), '[]'::jsonb)
  from instagram_automations.automations a
  join instagram_automations.accounts acc on acc.id = a.account_id and acc.status = 'connected'
  left join instagram_automations.comment_cursors cur on cur.media_id = a.published->>'mediaId'
  where a.mode in ('test', 'live') and a.archived_at is null and a.published->>'trigger' = 'comment';
$$;

create or replace function public.instagram_automations_save_cursor(p_account uuid, p_media_id text, p_newest timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into instagram_automations.comment_cursors as c (media_id, account_id, newest_comment_at, checked_at)
  values (p_media_id, p_account, p_newest, now())
  on conflict (media_id) do update set newest_comment_at = greatest(coalesce(c.newest_comment_at, excluded.newest_comment_at),
    coalesce(excluded.newest_comment_at, c.newest_comment_at)), checked_at = now();
$$;

-- "Próxima publicação": a primeira publicação depois da ativação vira a publicação da automação.
create or replace function public.instagram_automations_bind_next(p_automation uuid, p_media_id text, p_preview jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update instagram_automations.automations set
    published = published || jsonb_build_object('media', 'specific', 'mediaId', p_media_id, 'mediaPreview', p_preview),
    draft = draft || jsonb_build_object('media', 'specific', 'mediaId', p_media_id, 'mediaPreview', p_preview),
    updated_at = now()
  where id = p_automation and published->>'media' = 'next' and mode in ('test', 'live');
  return found;
end;
$$;

-- 17. Agendador: a cada minuto acorda a função (busca comentários, processa eventos e envia a fila).
create or replace function public.instagram_automations_cron_ok(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) >= 64 and p_secret = instagram_automations.read_secret('instagram_automations_cron_secret'), false);
$$;

create or replace function instagram_automations.tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text := instagram_automations.read_secret('instagram_automations_project_url');
begin
  -- Registros técnicos de recebimento ficam 30 dias; as conversas continuam em messages.
  delete from instagram_automations.events
  where id in (select e.id from instagram_automations.events e
               where e.status in ('done', 'failed') and e.created_at < now() - interval '30 days' limit 1000);
  if v_url is null then return; end if;
  if not exists (select 1 from instagram_automations.automations where mode in ('test', 'live') and archived_at is null)
     and not exists (select 1 from instagram_automations.events where status in ('pending', 'processing'))
     and not exists (select 1 from instagram_automations.messages where status in ('queued', 'sending')) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/functions/v1/automacoes',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-automacoes-cron', instagram_automations.read_secret('instagram_automations_cron_secret')),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000);
  -- Execuções e mensagens vencidas não ficam presas.
  update instagram_automations.runs set status = 'expired', updated_at = now()
  where status in ('ready', 'waiting', 'sending') and expires_at <= now();
end;
$$;

select cron.schedule('instagram-automations', '* * * * *', 'select instagram_automations.tick()');

-- 18. Só a chave secreta do projeto chama estas funções.
do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'instagram_automations'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function);
  end loop;
  for v_function in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'instagram\_automations\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
