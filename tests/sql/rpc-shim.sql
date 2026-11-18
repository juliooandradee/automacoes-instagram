-- Só para testes: recebe uma chamada no formato da API do Supabase (nome + argumentos em JSON)
-- e executa a função pública correspondente com os tipos certos. Nunca vai para o seu projeto.
create schema if not exists test_rpc;

create or replace function test_rpc.call(p_name text, p_args jsonb) returns jsonb language plpgsql as $$
declare
  v_proc record;
  v_parts text[] := '{}';
  v_name text;
  v_type text;
  v_result jsonb;
begin
  select p.proargnames, p.proargtypes, p.pronargs, p.prorettype into v_proc
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name limit 1;
  if not found then raise exception 'rpc % não existe', p_name; end if;
  for i in 0 .. v_proc.pronargs - 1 loop
    v_name := v_proc.proargnames[i + 1];
    v_type := format_type(v_proc.proargtypes[i], null);
    continue when not (coalesce(p_args, '{}'::jsonb) ? v_name);
    v_parts := v_parts || format('%I => %s', v_name, case
      when p_args->v_name = 'null'::jsonb then format('null::%s', v_type)
      when v_type = 'jsonb' then format('%L::jsonb', p_args->v_name)
      when v_type = 'text[]' then format('array(select jsonb_array_elements_text(%L::jsonb))::text[]', p_args->v_name)
      else format('%L::%s', p_args->>v_name, v_type) end);
  end loop;
  if v_proc.prorettype = 'void'::regtype then
    execute format('select public.%I(%s)', p_name, array_to_string(v_parts, ', '));
    return null;
  end if;
  execute format('select to_jsonb(public.%I(%s))', p_name, array_to_string(v_parts, ', ')) into v_result;
  return v_result;
end;
$$;
