// Comandos do quadro e da linha de comando. Só chegam aqui com a chave secreta do projeto.
import { GraphClient } from './graph.mjs';
import { FlowError, compileFlow, sharesEntryPoint } from './flows.mjs';

const IG_ID = /^[0-9]{5,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PanelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const requireId = (value, label = 'id') => {
  if (!UUID.test(value || '')) throw new PanelError(`Informe o ${label}.`);
  return value;
};

// Campos que o quadro edita. O resto do JSON é ignorado.
export function cleanDraft(draft) {
  if (!draft || typeof draft !== 'object') throw new PanelError('Automação inválida.');
  const name = String(draft.name || '').trim().slice(0, 120);
  if (!name) throw new PanelError('Dê um nome à automação.');
  const blocks = Array.isArray(draft.blocks) ? draft.blocks.slice(0, 20) : [];
  return {
    name, trigger: draft.trigger, media: draft.media, mediaId: draft.mediaId || null, mediaPreview: draft.mediaPreview || null,
    match: draft.match, keywords: String(draft.keywords || '').slice(0, 1000),
    publicReplies: (Array.isArray(draft.publicReplies) ? draft.publicReplies : []).map(item => String(item).slice(0, 1000)).slice(0, 20),
    blocks: blocks.map(block => ({
      id: String(block.id || ''), type: block.type === 'handoff' ? 'handoff' : 'message', text: String(block.text || '').slice(0, 1000),
      buttons: (Array.isArray(block.buttons) ? block.buttons : []).slice(0, 3).map(button => ({ id: String(button.id || ''),
        type: button.type === 'link' ? 'link' : 'reply', title: String(button.title || '').slice(0, 20),
        ...(button.type === 'link' ? { url: String(button.url || '').slice(0, 2000) } : { target: String(button.target || '') }) })),
      next: block.next ? String(block.next) : null, tag: String(block.tag || '').slice(0, 80),
    })),
  };
}

export function compileOrExplain(draft) {
  try {
    return compileFlow(draft);
  } catch (error) {
    if (error instanceof FlowError) throw new PanelError(error.message, 422);
    throw error;
  }
}

export function makePanel({ rest, version, fetcher = fetch, sendNow = async () => {} }) {
  const connection = account => rest.rpc('instagram_automations_connection', { p_account_key: account || 'principal' });
  const client = token => new GraphClient({ token, version, fetchImpl: fetcher });

  async function publish(body) {
    const id = requireId(body.id);
    const mode = ['off', 'test', 'live'].includes(body.mode) ? body.mode : null;
    if (!mode) throw new PanelError('Escolha: desligada, teste ou ativa.');
    if (mode === 'off') return rest.rpc('instagram_automations_publish', { p_id: id, p_mode: 'off', p_test_recipients: [], p_published: null });
    const recipients = [...new Set((body.test_recipients || []).map(String))];
    if (mode === 'test' && (!recipients.length || recipients.length > 5 || !recipients.every(item => IG_ID.test(item)))) {
      throw new PanelError('No teste, escolha de 1 a 5 pessoas que já falaram com o seu Instagram.');
    }
    const current = await rest.rpc('instagram_automations_get', { p_id: id });
    if (!current) throw new PanelError('Automação não encontrada.', 404);
    const compiled = compileOrExplain(current.draft);
    const others = await rest.rpc('instagram_automations_list', { p_account_key: body.account || 'principal', p_archived: false });
    const clash = others.find(item => item.id !== id && item.mode !== 'off' && item.published && sharesEntryPoint(compiled, item.published));
    if (clash) throw new PanelError(`"${clash.published.name}" já responde a esse mesmo gatilho e palavras. Desligue uma das duas.`, 409);
    return rest.rpc('instagram_automations_publish', { p_id: id, p_mode: mode, p_test_recipients: mode === 'test' ? recipients : [],
      p_published: compiled, p_revision: current.revision });
  }

  async function reply(body) {
    const contact = requireId(body.contact_id, 'contato');
    const text = String(body.text || '').trim();
    if (!text || text.length > 1000) throw new PanelError('Escreva uma mensagem de até 1.000 caracteres.');
    const id = await rest.rpc('instagram_automations_queue_manual', { p_contact: contact, p_text: text, p_request_id: requireId(body.request_id, 'pedido') });
    await sendNow();
    return { id };
  }

  async function media(body) {
    const account = await connection(body.account);
    return client(account.token).media(account.ig_user_id, body.after || undefined);
  }

  async function stories(body) {
    const account = await connection(body.account);
    try {
      return await client(account.token).stories(account.ig_user_id);
    } catch {
      return { items: [], warning: 'A Meta não listou os Stories agora. Use "qualquer Story" ou tente de novo.' };
    }
  }

  async function check(body) {
    const account = await connection(body.account);
    const graph = client(account.token);
    const profile = await graph.account(account.ig_user_id);
    let subscribed = account.subscribed;
    if (!subscribed) {
      subscribed = await graph.subscribePage(account.page_id).catch(() => false);
      await rest.rpc('instagram_automations_mark_subscribed', { p_account: account.account_id, p_ok: subscribed, p_error: subscribed ? null : 'INSCRICAO_PENDENTE' });
    }
    return { username: profile.username || account.username, followers: profile.followers_count ?? null, media_count: profile.media_count ?? null,
      subscribed, scopes: account.scopes };
  }

  const actions = {
    status: () => rest.rpc('instagram_automations_status'),
    check,
    media,
    stories,
    automations: body => rest.rpc('instagram_automations_list', { p_account_key: body.account || 'principal', p_archived: !!body.archived }),
    automation: body => rest.rpc('instagram_automations_get', { p_id: requireId(body.id) }),
    save: body => rest.rpc('instagram_automations_save', { p_id: body.id ? requireId(body.id) : null, p_account_key: body.account || 'principal',
      p_draft: cleanDraft(body.draft), p_revision: Number.isInteger(body.revision) ? body.revision : null }),
    validate: body => ({ ok: true, nodes: compileOrExplain(cleanDraft(body.draft)).nodes.length }),
    publish,
    archive: body => rest.rpc('instagram_automations_archive', { p_id: requireId(body.id), p_archived: body.archived !== false }),
    contacts: body => rest.rpc('instagram_automations_contacts', { p_account_key: body.account || 'principal', p_search: String(body.search || '').slice(0, 60), p_limit: 100 }),
    thread: body => rest.rpc('instagram_automations_thread', { p_contact: requireId(body.contact_id, 'contato'), p_limit: 150 }),
    reply,
    pause_contact: body => rest.rpc('instagram_automations_pause_contact', { p_contact: requireId(body.contact_id, 'contato'), p_paused: body.paused !== false }),
    // Pedido de exclusão de dados: apaga a pessoa, a conversa e o que veio dela.
    forget_contact: body => {
      if (body.confirm !== true) throw new PanelError('Confirme a exclusão dos dados dessa pessoa.');
      return rest.rpc('instagram_automations_forget_contact', { p_contact: requireId(body.contact_id, 'contato') });
    },
    // Desliga todas as automações da conta, cancela a fila e apaga a chave do Instagram do cofre.
    disconnect: body => {
      if (body.confirm !== true) throw new PanelError('Confirme a desconexão (na linha de comando: npm run desconectar -- --sim).');
      return rest.rpc('instagram_automations_disconnect', { p_account_key: body.account || 'principal' });
    },
  };

  return { actions };
}
