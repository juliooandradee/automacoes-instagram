// Conexão do Instagram pela tela oficial da Meta (login do Facebook para Empresas, chave da Página).
// 1. A linha de comando pede o link (start). 2. A pessoa autoriza. 3. A Meta volta aqui (callback): a chave da Página
// vai para o Vault, a Página instala o app para os eventos chegarem e a pessoa vê um texto simples com o resultado.
import { GraphClient, exchangeCode, inspectToken, loginDialogUrl, longLivedUserToken, pagesWithInstagram } from './graph.mjs';

const BACK = 'Pode fechar esta janela e voltar ao Claude Code ou ao Codex.';
export const REQUIRED_SCOPES = ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'pages_show_list',
  'pages_read_engagement', 'pages_manage_metadata', 'pages_messaging'];
const SAVE_ERRORS = { username_mismatch: 'outra-conta', missing_scopes: 'sem-permissao', instagram_in_use: 'em-uso' };

export const CONNECTION_TEXTS = {
  conectado: info => `Pronto! O Instagram @${info.username} está conectado às suas automações.${info.subscribed ? ''
    : '\n\nAtenção: a Página não confirmou a inscrição dos eventos. Rode: npm run conferir'}\n\n${BACK}`,
  cancelado: () => `Você cancelou a autorização na tela da Meta. Nada foi conectado.\n\n${BACK}`,
  invalido: () => 'Este link de conexão não é válido. Gere outro com: npm run conectar',
  expirado: () => 'Este pedido de conexão expirou (vale 30 minutos) ou já foi usado. Gere outro com: npm run conectar',
  'nao-configurado': () => 'O app da Meta ainda não foi configurado. Rode: npm run configurar',
  'erro-meta': info => `A Meta não confirmou a conexão (etapa: ${info.stage}). Confira o ID do app, a chave secreta e o endereço `
    + `de retorno no app da Meta, e tente de novo em alguns minutos.\n\n${BACK}`,
  'sem-conta': () => 'A Meta aprovou, mas não mostrou nenhuma Página com Instagram profissional ligado. Confira o vínculo no app do '
    + 'Instagram (Editar perfil → Página) e se você marcou a Página e o Instagram na tela da Meta. Depois rode: npm run conectar -- --retomar',
  'outra-conta': info => `A Meta mostrou ${info.found || 'outro Instagram'}, mas não o @${info.expected}. `
    + 'Rode de novo escolhendo o certo: npm run conectar -- --retomar --instagram @usuario',
  'varias-contas': info => `A Meta mostrou mais de um Instagram (${info.found}). Diga qual usar: npm run conectar -- --retomar --instagram @usuario`,
  'sem-permissao': info => `Faltaram permissões na autorização: ${info.missing}. Confira a configuração do login no app da Meta e conecte `
    + 'de novo aceitando todas.',
  'em-uso': () => 'Esse Instagram já está conectado a outra conta destas automações.',
  erro: () => 'Não foi possível salvar a conexão. Tente de novo com: npm run conectar',
};

export function choosePage(pages, expected) {
  if (!pages.length) return { code: 'sem-conta' };
  const page = expected ? pages.find(item => item.username.toLowerCase() === expected.toLowerCase())
    : pages.length === 1 ? pages[0] : null;
  if (page) return { page };
  return { code: expected ? 'outra-conta' : 'varias-contas', found: pages.map(item => `@${item.username}`).join(', '), expected };
}

export function makeConnect({ rest, redirectUri, fetcher = fetch }) {
  async function metaConfig() {
    const config = await rest.rpc('instagram_automations_meta_config');
    const ready = /^[0-9]+$/.test(config?.app_id || '') && config?.app_secret && /^[0-9]+$/.test(config?.config_id || '');
    return ready ? config : null;
  }

  async function save(config, pending, page, scopes) {
    const missing = REQUIRED_SCOPES.filter(scope => !scopes.includes(scope));
    if (missing.length) return { code: 'sem-permissao', info: { missing: missing.join(', ') } };
    try {
      await rest.rpc('instagram_automations_save_connection', { p_account: pending.account_id, p_page_id: page.pageId,
        p_ig_user_id: page.igUserId, p_username: page.username, p_token: page.pageToken, p_scopes: scopes });
    } catch (error) {
      return { code: SAVE_ERRORS[error.message] || 'erro', info: { expected: pending.expected_username } };
    }
    let subscribed = false;
    let failure = null;
    try {
      subscribed = await new GraphClient({ token: page.pageToken, version: config.graph_version, fetchImpl: fetcher }).subscribePage(page.pageId);
    } catch (error) {
      failure = String(error?.detail || error?.message || 'erro').slice(0, 200);
    }
    await rest.rpc('instagram_automations_mark_subscribed', { p_account: pending.account_id, p_ok: subscribed, p_error: failure });
    return { code: 'conectado', info: { username: page.username, subscribed } };
  }

  async function settle(config, pending, userToken) {
    const meta = { appId: config.app_id, appSecret: config.app_secret, version: config.graph_version, fetchImpl: fetcher };
    const granted = await inspectToken({ ...meta, token: userToken });
    const pages = await pagesWithInstagram({ token: userToken, version: config.graph_version, fetchImpl: fetcher });
    const choice = choosePage(pages, pending.expected_username);
    if (!choice.page) {
      await rest.rpc('instagram_automations_keep_pending', { p_account: pending.account_id, p_token: userToken, p_scopes: granted.scopes }).catch(() => null);
      return { code: choice.code, info: choice };
    }
    return save(config, pending, choice.page, granted.scopes);
  }

  async function start(body) {
    const config = await metaConfig();
    if (!config) return [{ error: CONNECTION_TEXTS['nao-configurado']() }, 409];
    const begun = await rest.rpc('instagram_automations_oauth_begin', { p_account_key: body.account || 'principal', p_expected_username: body.expected_username || null });
    const url = loginDialogUrl({ appId: config.app_id, configId: config.config_id, redirectUri, state: begun.state });
    return [{ url, account: begun.account, expected_username: begun.expected_username, expires_in_minutes: 30 }, 200];
  }

  async function resume(body) {
    const config = await metaConfig();
    if (!config) return [{ error: CONNECTION_TEXTS['nao-configurado']() }, 409];
    const pending = await rest.rpc('instagram_automations_take_pending', { p_account_key: body.account || 'principal', p_expected_username: body.expected_username || null });
    if (!pending?.token) return [{ error: 'Não há conexão esperando. Rode: npm run conectar' }, 409];
    let result;
    try {
      result = await settle(config, pending, pending.token);
    } catch {
      return [{ error: 'A Meta não respondeu. Tente de novo em alguns minutos.' }, 502];
    }
    const text = CONNECTION_TEXTS[result.code](result.info);
    return result.code === 'conectado' ? [{ ok: true, ...result.info, message: text }, 200] : [{ error: text }, 409];
  }

  async function callback(params) {
    if (params.get('error')) return [CONNECTION_TEXTS.cancelado(), 200];
    const state = params.get('state') || '';
    const code = params.get('code') || '';
    if (!/^[0-9a-f]{64}$/.test(state) || !code || code.length > 2048) return [CONNECTION_TEXTS.invalido(), 400];
    const config = await metaConfig();
    if (!config) return [CONNECTION_TEXTS['nao-configurado'](), 409];
    const pending = await rest.rpc('instagram_automations_oauth_consume', { p_state: state }).catch(() => null);
    if (!pending?.account_id) return [CONNECTION_TEXTS.expirado(), 410];
    const meta = { appId: config.app_id, appSecret: config.app_secret, version: config.graph_version, fetchImpl: fetcher };
    let result;
    let stage = 'troca do código';
    try {
      let token = await exchangeCode({ ...meta, redirectUri, code });
      token = await longLivedUserToken({ ...meta, token }).catch(() => token);
      stage = 'leitura das Páginas';
      result = await settle(config, pending, token);
    } catch {
      return [CONNECTION_TEXTS['erro-meta']({ stage }), 502];
    }
    return [CONNECTION_TEXTS[result.code](result.info), result.code === 'conectado' ? 200 : 409];
  }

  return { start, resume, callback };
}
