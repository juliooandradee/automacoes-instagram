// Cliente da Graph API da Meta pelo login do Facebook (chave da Página).
// Direct e respostas privadas saem pela plataforma do Messenger (POST /{id-da-página}/messages);
// comentários, publicações e Stories pela API do Instagram (graph.facebook.com/{id-do-instagram}).
// Roda só no servidor: as chaves nunca vão para o navegador nem para os registros.

const ACCOUNT_ID = /^[0-9]{5,40}$/;
const USERNAME = /^[A-Za-z0-9_.]{1,30}$/;
const GRAPH_PATH = /^(me|[0-9]{5,40})(\/(accounts|subscribed_apps|messages|replies|comments|media|stories|live_media))?$/;
const TIMEOUT_MS = 30000;
const WINDOW_CLOSED_SUBCODES = new Set([2534022, 2018278]);

// code: código de erro da Meta. uncertain: o envio pode ter acontecido, então nunca se repete às cegas.
export class MetaError extends Error {
  constructor(message, { code = null, subcode = null, status = 0, uncertain = false, detail = '' } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.uncertain = uncertain;
    this.detail = detail;
  }
}

async function readJson(response, method) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new MetaError('Resposta da Meta não confirmada.', { status: response.status, uncertain: method === 'POST' });
  }
  if (response.ok && !data?.error) return data;
  const code = Number(data?.error?.code) || null;
  throw new MetaError(`A Meta recusou a operação (código ${code || response.status}).`, {
    code, subcode: Number(data?.error?.error_subcode) || null, status: response.status,
    uncertain: method === 'POST' && response.status >= 500, detail: String(data?.error?.message || '').slice(0, 200),
  });
}

async function send(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), ...options });
  } catch {
    throw new MetaError('Resposta da Meta não confirmada.', { uncertain: options.method === 'POST' });
  }
}

export const windowClosed = error => error?.code === 10 && WINDOW_CLOSED_SUBCODES.has(error?.subcode);

const isoTime = value => {
  const time = new Date(typeof value === 'string' ? value : '');
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
};
const httpsUrl = value => {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};
// Miniatura para o quadro: capa do vídeo ou a própria foto.
export const mediaItem = item => ({
  id: String(item.id), caption: String(item.caption || '').slice(0, 300), type: item.media_type || null,
  product: item.media_product_type || null, timestamp: isoTime(item.timestamp),
  permalink: /^https:\/\/www\.instagram\.com\//.test(item.permalink || '') ? item.permalink : null,
  thumbnailUrl: httpsUrl(item.media_type === 'VIDEO' ? item.thumbnail_url : item.media_url),
});

export class GraphClient {
  constructor({ token, version, fetchImpl = fetch }) {
    if (!token || !/^v\d+\.\d+$/.test(version || '')) throw new Error('Configure a chave e a versão da API da Meta.');
    this.token = token;
    this.base = `https://graph.facebook.com/${version}`;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', query = {}, json, form } = {}) {
    if (!GRAPH_PATH.test(path)) throw new MetaError('Destino da Meta inválido.');
    const url = new URL(`${this.base}/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const headers = { Authorization: `Bearer ${this.token}` };
    const options = { method, headers };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(json);
    } else if (form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(form);
    }
    return readJson(await send(this.fetch, url, options), method);
  }

  // A Página instala o app para os eventos do Instagram chegarem ao webhook. Os campos do Instagram não entram aqui:
  // a Meta pede um campo da Página, e o Direct do Instagram vem pela assinatura "instagram" feita no painel do app.
  async subscribePage(pageId) {
    const result = await this.request(`${pageId}/subscribed_apps`, { method: 'POST', form: { subscribed_fields: 'messages,messaging_postbacks' } });
    if (result?.success !== true) throw new MetaError('A Meta não confirmou a inscrição da Página.');
    return true;
  }

  async sendMessage(pageId, body) {
    const result = await this.request(`${pageId}/messages`, { method: 'POST', json: { ...body } });
    if (typeof result?.message_id !== 'string') throw new MetaError('A Meta não devolveu o id da mensagem.', { uncertain: true });
    return { messageId: result.message_id, recipientId: result.recipient_id ? String(result.recipient_id) : null };
  }

  async replyPublic(commentId, text) {
    const result = await this.request(`${commentId}/replies`, { method: 'POST', form: { message: text } });
    if (typeof result?.id !== 'string') throw new MetaError('A Meta não devolveu o id da resposta.', { uncertain: true });
    return { messageId: result.id };
  }

  async comment(commentId) {
    const data = await this.request(commentId, { query: { fields: 'id,timestamp,media{id}' } });
    return { id: String(data.id), createdAt: isoTime(data.timestamp), mediaId: String(data.media?.id || '') };
  }

  async comments(mediaId, after) {
    const data = await this.request(`${mediaId}/comments`, {
      query: { fields: 'id,text,timestamp,username,from{id,username}', limit: '50', ...(after ? { after } : {}) },
    });
    const items = (data.data || []).map(item => ({
      id: String(item.id), text: String(item.text || '').slice(0, 2200), timestamp: isoTime(item.timestamp),
      fromId: ACCOUNT_ID.test(String(item.from?.id || '')) ? String(item.from.id) : null,
      username: USERNAME.test(item.from?.username || item.username || '') ? String(item.from?.username || item.username).toLowerCase() : null,
    })).filter(item => ACCOUNT_ID.test(item.id) && item.timestamp);
    return { items, after: data.paging?.next ? data.paging?.cursors?.after || null : null };
  }

  async media(igUserId, after) {
    const fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';
    const data = await this.request(`${igUserId}/media`, { query: { fields, limit: '30', ...(after ? { after } : {}) } });
    return { items: (data.data || []).map(mediaItem), after: data.paging?.next ? data.paging?.cursors?.after || null : null };
  }

  async stories(igUserId) {
    const data = await this.request(`${igUserId}/stories`, { query: { fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp' } });
    return { items: (data.data || []).map(mediaItem) };
  }

  async liveMedia(igUserId) {
    const data = await this.request(`${igUserId}/live_media`, { query: { fields: 'id,media_type,media_product_type,timestamp' } });
    return (data.data || []).map(item => ({ id: String(item.id), timestamp: isoTime(item.timestamp) })).filter(item => ACCOUNT_ID.test(item.id));
  }

  async profile(igsid) {
    const data = await this.request(igsid, { query: { fields: 'name,username' } });
    return {
      name: typeof data.name === 'string' ? data.name.slice(0, 120) : null,
      username: USERNAME.test(data.username || '') ? String(data.username).toLowerCase() : null,
    };
  }

  account(igUserId) {
    return this.request(igUserId, { query: { fields: 'id,username,followers_count,media_count' } });
  }
}

// Tela oficial da Meta (login do Facebook para Empresas, com o ID da configuração do login).
export function loginDialogUrl({ appId, configId, redirectUri, state }) {
  const url = new URL('https://www.facebook.com/dialog/oauth');
  const values = { client_id: appId, config_id: configId, redirect_uri: redirectUri, response_type: 'code',
    override_default_response_type: 'true', prompt: 'login', state };
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url.href;
}

async function graphGet(fetchImpl, version, path, values, token) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return readJson(await send(fetchImpl, url, { method: 'GET', headers }), 'GET');
}

export async function checkAppCredentials({ appId, appSecret, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token', { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' });
  if (!data?.access_token) throw new MetaError('A Meta não confirmou o app.');
  return true;
}

export async function exchangeCode({ appId, appSecret, redirectUri, code, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  if (!data?.access_token) throw new MetaError('A Meta não devolveu a autorização.');
  return data.access_token;
}

// A chave de usuário vira de longa duração; a chave de Página tirada dela não vence.
export async function longLivedUserToken({ appId, appSecret, token, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token',
    { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token });
  if (!data?.access_token) throw new MetaError('A Meta não devolveu a chave de longa duração.');
  return data.access_token;
}

export async function inspectToken({ token, appId, appSecret, version, fetchImpl = fetch }) {
  const { data } = await graphGet(fetchImpl, version, 'debug_token', { input_token: token, access_token: `${appId}|${appSecret}` });
  if (!data?.is_valid || String(data.app_id) !== String(appId)) throw new MetaError('A Meta não confirmou a chave deste app.');
  const granular = data.granular_scopes || [];
  return { scopes: data.scopes?.length ? data.scopes : granular.map(item => item.scope), type: String(data.type || '') };
}

// Páginas que a pessoa liberou na tela da Meta, cada uma com o Instagram ligado e a chave da Página.
export async function pagesWithInstagram({ token, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'me/accounts',
    { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' }, token);
  return (data.data || []).filter(page => ACCOUNT_ID.test(String(page.id)) && typeof page.access_token === 'string'
    && ACCOUNT_ID.test(String(page.instagram_business_account?.id || '')) && USERNAME.test(page.instagram_business_account?.username || ''))
    .map(page => ({ pageId: String(page.id), pageName: String(page.name || '').slice(0, 120), pageToken: page.access_token,
      igUserId: String(page.instagram_business_account.id), username: page.instagram_business_account.username }));
}
