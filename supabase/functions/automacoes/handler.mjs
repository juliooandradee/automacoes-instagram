// Função "automacoes" do Supabase. Uma só porta de entrada:
//   GET  ?hub.mode=subscribe     -> verificação do webhook pela Meta;
//   POST com X-Hub-Signature-256 -> eventos do Instagram (Direct, Story, botões e, com acesso avançado, comentários);
//   GET  /l/<código>             -> link rastreado: registra o clique e leva ao destino;
//   GET  /privacidade            -> política de privacidade em texto (endereço para o app da Meta);
//   GET  ?code&state             -> volta da tela da Meta (conexão), em texto simples;
//   POST com x-automacoes-cron   -> o agendador: busca comentários, processa eventos e envia a fila;
//   POST com a chave secreta     -> comandos do quadro e da linha de comando.
import { MetaError, checkAppCredentials } from '../_shared/graph.mjs';
import { makeConnect } from '../_shared/connect.mjs';
import { describeWebhook, normalizeWebhook } from '../_shared/events.mjs';
import { makeEngine } from '../_shared/engine.mjs';
import { PanelError, makePanel } from '../_shared/panel.mjs';
import { makePoller } from '../_shared/poll.mjs';
import { privacyText } from '../_shared/privacy.mjs';
import { RestError, createRest, hmacSha256Hex, presentedKey, sameSecret, serverKeys, sha256Hex } from '../_shared/rest.mjs';

const FUNCTION_PATH = '/functions/v1/automacoes';
const MAX_BODY = 1024 * 1024;
const LINK = /\/l\/([A-Za-z0-9_-]{20,64})\/?$/;
const PRIVACY = /\/privacidade\/?$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

function failure(error) {
  if (error instanceof PanelError) return json({ error: error.message }, error.status);
  if (error?.message === 'not_connected') return json({ error: 'Conecte o Instagram antes (npm run conectar).' }, 409);
  if (error instanceof MetaError) return json({ error: `A Meta recusou (código ${error.code || error.status}). ${error.detail || ''}`.trim() }, 502);
  if (error instanceof RestError) return json({ error: error.message }, error.status >= 400 && error.status < 500 ? 409 : 502);
  return json({ error: `Não foi possível concluir: ${error?.message || 'erro desconhecido'}.` }, 500);
}

export function makeHandler({ env, fetcher = fetch, background = promise => promise, now = () => Date.now(), random = Math.random }) {
  const projectUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const keys = serverKeys(env);
  const rest = createRest({ url: projectUrl, key: keys[0] || '', fetcher });
  const redirectUri = projectUrl + FUNCTION_PATH;
  const connect = makeConnect({ rest, redirectUri, fetcher });
  const metaConfig = () => rest.rpc('instagram_automations_meta_config');
  const engineFor = async () => {
    const config = await metaConfig();
    return makeEngine({ rest, version: config?.graph_version || 'v26.0', linkBase: redirectUri, fetcher, now, random });
  };

  async function tick(budgetMs = 100000) {
    const deadline = now() + budgetMs;
    const config = await metaConfig();
    const poll = await makePoller({ rest, version: config?.graph_version || 'v26.0', fetcher }).run(now() + Math.min(budgetMs / 2, 40000), now);
    const engine = makeEngine({ rest, version: config?.graph_version || 'v26.0', linkBase: redirectUri, fetcher, now, random });
    const events = await engine.processEvents(deadline - 15000);
    const sent = await engine.sendQueue(deadline);
    return { comments: poll.found, poll_errors: poll.errors, events, sent };
  }

  async function configure(body) {
    let meta = null;
    if (body.app_id) {
      meta = { appId: String(body.app_id).trim(), appSecret: String(body.app_secret || '').trim(), configId: String(body.config_id || '').trim(),
        version: String(body.graph_version || 'v26.0').trim() };
      if (!meta.appSecret) {
        const stored = await metaConfig();
        if (stored?.app_id === meta.appId) meta.appSecret = stored.app_secret || '';
      }
      if (!meta.appSecret) return json({ error: 'Falta a chave secreta do app da Meta (META_APP_SECRET no .env).' }, 422);
      try {
        await checkAppCredentials({ ...meta, fetchImpl: fetcher });
      } catch {
        return json({ error: 'A Meta não reconheceu o ID do app com essa chave secreta. Confira em Configurações do app → Básico.' }, 422);
      }
    }
    const saved = await rest.rpc('instagram_automations_configure', { p_project_url: projectUrl, p_app_id: meta?.appId || null,
      p_app_secret: meta?.appSecret || null, p_config_id: meta?.configId || null, p_graph_version: meta?.version || null });
    return json({ ok: true, redirect_uri: redirectUri, webhook_url: redirectUri, privacy_url: `${redirectUri}/privacidade`,
      verify_token: saved.verify_token, meta_configured: saved.meta_configured });
  }

  const commands = {
    health: async () => json({ ok: true, redirect_uri: redirectUri, status: await rest.rpc('instagram_automations_status') }),
    configure,
    connect: async body => json(...await connect.start(body)),
    resume: async body => json(...await connect.resume(body)),
    tick: async () => json(await tick()),
  };

  async function command(request) {
    if (!keys.some(key => sameSecret(presentedKey(request), key))) {
      return json({ error: 'Não autorizado. Use a chave secreta do projeto (SUPABASE_SECRET_KEY no arquivo .env).' }, 401);
    }
    const raw = await request.text();
    if (raw.length > 100000) return json({ error: 'Solicitação muito grande.' }, 413);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json({ error: 'Solicitação inválida.' }, 400);
    }
    const action = String(body?.action || '');
    if (Object.hasOwn(commands, action)) return commands[action](body);
    const config = await metaConfig();
    const panel = makePanel({ rest, version: config?.graph_version || 'v26.0', fetcher,
      sendNow: async () => (await engineFor()).sendQueue(now() + 20000) });
    if (!Object.hasOwn(panel.actions, action)) return json({ error: 'Ação desconhecida.' }, 400);
    return json((await panel.actions[action](body)) ?? null);
  }

  async function webhook(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY) return text('Grande demais.', 413);
    const config = await metaConfig();
    const signature = (request.headers.get('x-hub-signature-256') || '').replace(/^sha256=/, '');
    if (!config?.app_secret || !sameSecret(signature, await hmacSha256Hex(config.app_secret, bytes))) return text('Assinatura inválida.', 401);
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return text('Corpo inválido.', 400);
    }
    const events = await normalizeWebhook(body);
    const byAccount = new Map();
    for (const event of events) byAccount.set(event.account, [...(byAccount.get(event.account) || []), event]);
    let stored = 0;
    for (const [account, list] of byAccount) stored += await rest.rpc('instagram_automations_ingest', { p_ig_user_id: account, p_events: list });
    console.log(`Webhook Instagram: ${describeWebhook(body)} · ${stored} novo(s)`);
    if (stored) await background(tick(80000).catch(error => console.error(`Processamento: ${error?.message || error}`)));
    return text('EVENT_RECEIVED');
  }

  async function verify(params) {
    const config = await metaConfig();
    if (params.get('hub.mode') === 'subscribe' && config?.verify_token && sameSecret(params.get('hub.verify_token') || '', config.verify_token)) {
      return text(params.get('hub.challenge') || '');
    }
    return text('Verificação recusada.', 403);
  }

  async function privacy() {
    const status = await rest.rpc('instagram_automations_status').catch(() => null);
    const handles = (status?.accounts || []).filter(account => account.username).map(account => `@${account.username}`);
    return text(privacyText(handles.join(', ') || 'deste perfil'));
  }

  async function link(code) {
    const destination = await rest.rpc('instagram_automations_click', { p_token_hash: await sha256Hex(code) });
    if (!destination) return text('Link não encontrado.', 404);
    return new Response(null, { status: 302, headers: { Location: destination, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const params = url.searchParams;
        const code = url.pathname.match(LINK)?.[1];
        if (code) return await link(code);
        if (PRIVACY.test(url.pathname)) return await privacy();
        if (params.has('hub.mode')) return await verify(params);
        if (params.has('code') || params.has('state') || params.has('error')) return text(...await connect.callback(params));
        return text('Automações do Instagram no ar.');
      }
      if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
      if (request.headers.get('x-hub-signature-256')) return await webhook(request);
      const cron = request.headers.get('x-automacoes-cron');
      if (cron) {
        const allowed = await rest.rpc('instagram_automations_cron_ok', { p_secret: cron }).catch(() => false);
        return allowed === true ? json(await tick()) : json({ error: 'Não autorizado.' }, 401);
      }
      return await command(request);
    } catch (error) {
      return failure(error);
    }
  };
}
