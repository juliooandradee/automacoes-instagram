-- Testes do banco das automações. Rodam numa transação desfeita no final.
begin;

create function pg_temp.expect_error(p_sql text, p_fragment text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_fragment in sqlerrm) = 0 then raise exception 'Erro inesperado: % (esperava "%")', sqlerrm, p_fragment; end if;
    return;
  end;
  raise exception 'Esperava um erro com "%" em: %', p_fragment, p_sql;
end;
$$;

do $$
begin
  assert not has_function_privilege('anon', 'public.instagram_automations_status()', 'execute'), 'anon chama status';
  assert not has_function_privilege('authenticated', 'public.instagram_automations_claim_outbound(integer)', 'execute');
  assert has_function_privilege('service_role', 'public.instagram_automations_claim_outbound(integer)', 'execute');
  assert not has_function_privilege('service_role', 'instagram_automations.read_secret(text)', 'execute');
  assert not has_schema_privilege('anon', 'instagram_automations', 'usage');
  assert (select count(*) from cron.job where jobname = 'instagram-automations') = 1;
  assert (select count(*) from vault.secrets where name = 'instagram_automations_verify_token') = 1;
end;
$$;

grant usage on schema instagram_automations, vault, net, cron to service_role;
grant select on all tables in schema instagram_automations to service_role;
grant insert on instagram_automations.events to service_role; -- só no teste: simula um evento antigo
grant select on vault.secrets, vault.decrypted_secrets, net.requests, cron.job to service_role;
set local role service_role;

-- Configuração e conexão.
do $$
declare
  v_begin jsonb;
  v_pending jsonb;
  v_account uuid;
begin
  assert (public.instagram_automations_configure('https://abc.supabase.co', null, null, null, null)->>'meta_configured')::boolean = false;
  assert length(public.instagram_automations_configure('https://abc.supabase.co', '1234567890', repeat('ab', 16), '987654321', 'v26.0')->>'verify_token') = 48;
  assert public.instagram_automations_meta_config()->>'config_id' = '987654321';
  v_begin := public.instagram_automations_oauth_begin('principal', '@Consultorio.Exemplo');
  v_pending := public.instagram_automations_oauth_consume(v_begin->>'state');
  assert v_pending->>'expected_username' = 'consultorio.exemplo';
  assert public.instagram_automations_oauth_consume(v_begin->>'state') is null, 'pedido usado duas vezes';
  v_account := (v_pending->>'account_id')::uuid;
  perform pg_temp.expect_error(format($q$select public.instagram_automations_save_connection(%L, '500100', '17841400000000001', 'consultorio.exemplo', repeat('t', 40), array['instagram_basic'])$q$, v_account), 'missing_scopes');
  perform public.instagram_automations_save_connection(v_account, '500100', '17841400000000001', 'consultorio.exemplo', repeat('t', 40),
    array['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'pages_messaging', 'pages_manage_metadata']);
  assert public.instagram_automations_connection('principal')->>'token' = repeat('t', 40);
  assert public.instagram_automations_connection('principal')->>'page_id' = '500100';
end;
$$;

-- Automação: rascunho, publicação, revisão e lixeira.
do $$
declare
  v_row jsonb;
  v_id uuid;
begin
  v_row := public.instagram_automations_save(null, 'principal', '{"name":"Comente GUIA","trigger":"comment","media":"specific","mediaId":"18000000000000001"}', null);
  v_id := (v_row->>'id')::uuid;
  assert v_row->>'mode' = 'off' and (v_row->>'revision')::integer = 1;
  perform pg_temp.expect_error(format($q$select public.instagram_automations_save(%L, 'principal', '{"name":"x"}', 7)$q$, v_id), 'mudou em outra janela');
  v_row := public.instagram_automations_save(v_id, 'principal', '{"name":"Comente GUIA","trigger":"comment","media":"specific","mediaId":"18000000000000001"}', 1);
  assert (v_row->>'revision')::integer = 2;
  perform pg_temp.expect_error(format($q$select public.instagram_automations_publish(%L, 'test', '{}', '{"trigger":"comment"}')$q$, v_id), 'check');
  v_row := public.instagram_automations_publish(v_id, 'live', '{}',
    '{"trigger":"comment","media":"specific","mediaId":"18000000000000001","nodes":[{"id":"b1","text":"Oi"}]}');
  assert v_row->>'mode' = 'live' and v_row->>'activated_at' is not null;
  assert not (v_row->>'changed_since_publish')::boolean, 'acabou de publicar: rascunho igual ao publicado';
  perform pg_temp.expect_error(format($q$select public.instagram_automations_publish(%L, 'live', '{}', '{"trigger":"comment"}', 1)$q$, v_id), 'mudou em outra janela');
  v_row := public.instagram_automations_save(v_id, 'principal', '{"name":"Comente GUIA 2","trigger":"comment","media":"specific","mediaId":"18000000000000001"}', 2);
  assert (v_row->>'changed_since_publish')::boolean, 'rascunho mudou depois de publicar';
  assert v_row->'published'->'nodes'->0->>'text' = 'Oi', 'o publicado continua o mesmo até publicar de novo';
  perform pg_temp.expect_error(format($q$select public.instagram_automations_archive(%L, true)$q$, v_id), 'Desligue');
  assert jsonb_array_length(public.instagram_automations_active((select id from instagram_automations.accounts))) = 1;
  assert jsonb_array_length(public.instagram_automations_comment_targets()) = 1;
  assert public.instagram_automations_comment_targets()->0->>'token' = repeat('t', 40);
end;
$$;

-- Eventos: gravados uma vez e processados um por vez em cada conta.
do $$
declare
  v_first jsonb;
begin
  assert public.instagram_automations_ingest('17841400000000001', '[{"key":"comment:1","kind":"comment"},{"key":"comment:1","kind":"comment"},{"key":"message:2","kind":"direct"}]') = 2;
  assert public.instagram_automations_ingest('17841400000000001', '[{"key":"comment:1","kind":"comment"}]') = 0;
  assert public.instagram_automations_ingest('99999999999', '[{"key":"x","kind":"direct"}]') = 0, 'conta desconhecida';
  v_first := public.instagram_automations_claim_event(120);
  assert v_first->'event'->>'key' = 'comment:1';
  assert public.instagram_automations_claim_event(120) is null, 'dois eventos da mesma conta ao mesmo tempo';
  perform public.instagram_automations_finish_event((v_first->>'id')::uuid, 'done', null);
  assert public.instagram_automations_claim_event(120)->'event'->>'key' = 'message:2';
end;
$$;

-- Contato, execução, fila, rota escolhida e envio.
do $$
declare
  v_account uuid := (select id from instagram_automations.accounts);
  v_automation uuid := (select id from instagram_automations.automations);
  v_contact jsonb;
  v_run jsonb;
  v_message uuid;
  v_claim jsonb;
  v_route jsonb;
begin
  v_contact := public.instagram_automations_touch_contact(v_account, '700100', 'Pessoa.Teste', false, now(), 'GUIA');
  assert v_contact->>'username' = 'pessoa.teste' and v_contact->>'last_inbound_at' is null, 'comentário não abre a janela';
  assert public.instagram_automations_record_inbound(v_account, (v_contact->>'id')::uuid, 'comment', 'GUIA', '17900000000000111', null) is not null;
  assert public.instagram_automations_record_inbound(v_account, (v_contact->>'id')::uuid, 'comment', 'GUIA', '17900000000000111', null) is null, 'comentário duplicado';
  v_run := public.instagram_automations_start_run(v_account, (v_contact->>'id')::uuid, v_automation, null,
    '[{"id":"b1","text":"Oi"},{"id":"b2","text":"Link"}]', '17900000000000111', '18000000000000001', false, true);
  assert v_run is not null;
  assert public.instagram_automations_start_run(v_account, (v_contact->>'id')::uuid, v_automation, null, '[]', '17900000000000112', null, false, true) is null,
    'segunda execução com a primeira ativa';
  v_message := public.instagram_automations_queue_step((v_run->>'id')::uuid, 0, 'private_reply', 'Oi',
    '{"recipient":{"comment_id":"17900000000000111"},"message":{"text":"Oi"}}', now() + interval '7 days',
    jsonb_build_array(jsonb_build_object('token_hash', repeat('a', 64), 'destination', 'https://exemplo.com/guia')), repeat('h', 64), 'LIBERAR');
  assert v_message is not null;
  assert public.instagram_automations_queue_step((v_run->>'id')::uuid, 0, 'private_reply', 'Oi', '{}', now(), '[]', null, null) is null,
    'mesmo passo na fila duas vezes';
  v_claim := public.instagram_automations_claim_outbound(60);
  assert v_claim->'message'->>'id' = v_message::text and v_claim->>'token' = repeat('t', 40);
  assert public.instagram_automations_claim_outbound(60) is null, 'duas mensagens da mesma conta ao mesmo tempo';
  perform public.instagram_automations_finish_outbound(v_message, 'accepted', 'mid.1', null, 'waiting', null);
  assert (select status = 'waiting' and waiting_hash = repeat('h', 64) from instagram_automations.runs where id = (v_run->>'id')::uuid);
  v_route := public.instagram_automations_choose_route((v_run->>'id')::uuid, 0, 1, 'liberar', now());
  assert v_route->>'status' = 'ready' and (v_route->>'next_index')::integer = 1;
  assert public.instagram_automations_choose_route((v_run->>'id')::uuid, 0, 1, 'liberar', now()) is null, 'botão usado duas vezes';
  assert public.instagram_automations_queue_public_reply((v_run->>'id')::uuid, 'Te chamei no Direct!') is not null;
  assert public.instagram_automations_queue_public_reply((v_run->>'id')::uuid, 'De novo') is null, 'resposta pública duplicada';
  assert public.instagram_automations_click(repeat('a', 64)) = 'https://exemplo.com/guia';
  assert public.instagram_automations_click(repeat('b', 64)) is null;
  assert (public.instagram_automations_get(v_automation)->'metrics'->>'clicked')::integer = 1;
  assert (public.instagram_automations_get(v_automation)->'metrics'->>'sent')::integer = 1;
end;
$$;

-- Resposta manual: só na janela de 24 horas e pausa a automação da pessoa.
do $$
declare
  v_account uuid := (select id from instagram_automations.accounts);
  v_contact uuid := (select id from instagram_automations.contacts where igsid = '700100');
begin
  perform pg_temp.expect_error(format($q$select public.instagram_automations_queue_manual(%L, 'Oi!', gen_random_uuid())$q$, v_contact), 'janela de 24 horas');
  perform public.instagram_automations_touch_contact(v_account, '700100', null, true, now(), 'Oi');
  assert public.instagram_automations_queue_manual(v_contact, 'Oi! Respondendo à mão.', gen_random_uuid()) is not null;
  assert (select automation_paused from instagram_automations.contacts where id = v_contact);
  assert public.instagram_automations_record_echo(v_account, v_contact, 'eco', 'mid.1') = false, 'eco de mensagem nossa';
  assert public.instagram_automations_record_echo(v_account, v_contact, 'eco rápido', 'mid.998') = false, 'envio recente conta como nosso';
end;
$$;
reset role;
update instagram_automations.messages set created_at = now() - interval '10 minutes';
set local role service_role;
do $$
declare
  v_account uuid := (select id from instagram_automations.accounts);
  v_contact uuid := (select id from instagram_automations.contacts where igsid = '700100');
begin
  assert public.instagram_automations_record_echo(v_account, v_contact, 'pelo celular', 'mid.999') = true;
  assert (public.instagram_automations_pause_contact(v_contact, false)->>'automation_paused')::boolean = false;
  assert jsonb_array_length(public.instagram_automations_thread(v_contact, 50)->'messages') >= 4;
  assert jsonb_array_length(public.instagram_automations_contacts('principal', 'pessoa', 10)) = 1;
end;
$$;

-- Exclusão de dados de uma pessoa e limpeza dos eventos antigos.
do $$
declare
  v_account uuid := (select id from instagram_automations.accounts);
  v_contact uuid;
  v_result jsonb;
begin
  v_contact := (public.instagram_automations_touch_contact(v_account, '700999', 'apagar.me', true, now(), 'oi')->>'id')::uuid;
  perform public.instagram_automations_record_inbound(v_account, v_contact, 'direct', 'meus dados', 'mid.apagar', '{}');
  perform public.instagram_automations_ingest('17841400000000001', '[{"key":"dm:apagar","kind":"direct","scopedId":"700999","text":"meus dados"}]');
  assert exists (select 1 from instagram_automations.events where payload->>'scopedId' = '700999'), 'evento gravado';
  v_result := public.instagram_automations_forget_contact(v_contact);
  assert v_result->>'username' = 'apagar.me' and (v_result->>'messages')::integer = 1;
  assert not exists (select 1 from instagram_automations.contacts where igsid = '700999'), 'contato apagado';
  assert not exists (select 1 from instagram_automations.messages where contact_id = v_contact), 'mensagens apagadas';
  assert not exists (select 1 from instagram_automations.events where payload->>'scopedId' = '700999'), 'eventos apagados';
  assert exists (select 1 from instagram_automations.contacts where igsid = '700100'), 'os outros ficam';
  perform pg_temp.expect_error(format($q$select public.instagram_automations_forget_contact(%L)$q$, v_contact), 'não encontrado');
  insert into instagram_automations.events (account_id, key, kind, payload, status, created_at)
  values (v_account, 'velho', 'direct', '{}', 'done', now() - interval '40 days');
end;
$$;

-- O agendador roda como dono do banco (pg_cron), não com a chave do projeto.
reset role;
do $$
begin
  perform instagram_automations.tick();
  assert not exists (select 1 from instagram_automations.events where key = 'velho'), 'evento de 40 dias apagado';
  assert exists (select 1 from instagram_automations.events where status = 'pending' or created_at > now() - interval '1 day'), 'os recentes ficam';
end;
$$;
set local role service_role;

-- Próxima publicação e desconexão.
do $$
declare
  v_row jsonb := public.instagram_automations_save(null, 'principal', '{"name":"Próxima","trigger":"comment","media":"next"}', null);
  v_id uuid := (v_row->>'id')::uuid;
begin
  perform public.instagram_automations_publish(v_id, 'test', array['700100'], '{"trigger":"comment","media":"next","nodes":[]}');
  assert public.instagram_automations_bind_next(v_id, '18000000000000009', '{"caption":"Nova"}');
  assert public.instagram_automations_get(v_id)->'published'->>'mediaId' = '18000000000000009';
  assert not public.instagram_automations_bind_next(v_id, '18000000000000010', '{}'), 'vincula uma vez só';
  perform public.instagram_automations_save_cursor((select id from instagram_automations.accounts), '18000000000000009', now());
  assert public.instagram_automations_disconnect('principal')->>'username' = 'consultorio.exemplo';
  assert (select count(*) from instagram_automations.automations where mode <> 'off') = 0, 'desconectar desliga as automações';
  perform pg_temp.expect_error($q$select public.instagram_automations_connection('principal')$q$, 'not_connected');
  assert public.instagram_automations_cron_ok((select decrypted_secret from vault.decrypted_secrets where name = 'instagram_automations_cron_secret'));
  assert not public.instagram_automations_cron_ok('x');
end;
$$;

rollback;
