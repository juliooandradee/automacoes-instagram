// Motor das automações: aplica cada evento (início, botão escolhido, eco, visto) e envia a fila.
// Cada passo é gravado no banco antes de falar com a Meta: nada é enviado duas vezes.
import { GraphClient, MetaError, windowClosed } from './graph.mjs';
import { flowPriority, matchesFlow, nextIndex, publicReplyOptions, replyButtons, testAllows } from './flows.mjs';
import { randomToken, sha256Hex } from './rest.mjs';

const HOUR = 3600000;
const OPENS_WINDOW = new Set(['direct', 'story_reply', 'story_mention', 'postback']);
const STARTS = new Set(['comment', 'direct', 'story_reply', 'story_mention']);
const HOURLY_LIMIT = 100;

export function makeEngine({ rest, version, linkBase, fetcher = fetch, now = () => Date.now(), random = Math.random }) {
  const graph = token => new GraphClient({ token, version, fetchImpl: fetcher });
  const runUpdate = (run, fields) => rest.rpc('instagram_automations_run_update', {
    p_run: run.id, p_status: fields.status ?? null, p_next_index: fields.next ?? null, p_tag: fields.tag ?? null, p_pause_contact: !!fields.pause });

  // Primeira resposta a um comentário vai pelo comentário (respostas rápidas); as outras pela conversa (botões).
  async function buildStep(run, contact, node, index) {
    const isPrivate = index === 0 && !!run.comment_id;
    const windowEnd = contact.last_inbound_at ? new Date(Date.parse(contact.last_inbound_at) + 24 * HOUR).toISOString() : null;
    const expiresAt = isPrivate ? run.expires_at : windowEnd;
    if (!expiresAt || Date.parse(expiresAt) <= now()) return null;
    const replies = replyButtons(node);
    const token = replies.length ? `ig:${randomToken()}` : null;
    const links = [];
    for (const button of node.buttons.filter(item => item.type === 'link')) {
      const code = randomToken();
      links.push({ id: button.id, token_hash: await sha256Hex(code), destination: button.url, url: `${linkBase}/l/${code}` });
    }
    const quick = { text: node.text, quick_replies: replies.map(button => ({ content_type: 'text', title: button.title, payload: `${token}:${button.id}` })) };
    const template = { attachment: { type: 'template', payload: { template_type: 'button', text: node.text,
      buttons: node.buttons.map(button => (button.type === 'reply' ? { type: 'postback', title: button.title, payload: `${token}:${button.id}` }
        : { type: 'web_url', title: button.title, url: links.find(link => link.id === button.id).url })) } } };
    const message = !node.buttons.length ? { text: node.text } : isPrivate && replies.length ? quick : template;
    return {
      kind: isPrivate ? 'private_reply' : 'text',
      text: node.text + (replies.length ? `\n[${replies.map(button => button.title).join(' / ')}]` : ''),
      payload: { recipient: isPrivate ? { comment_id: run.comment_id } : { id: contact.igsid }, message, analytics: { node_id: node.id } },
      expiresAt, links: links.map(({ token_hash, destination }) => ({ token_hash, destination })),
      waitingHash: token ? await sha256Hex(token) : null, waitingLabel: replies[0]?.title || null,
    };
  }

  async function advance(run, contact) {
    const index = run.next_index;
    const node = run.nodes[index];
    if (!node) return (await runUpdate(run, { status: 'done', next: run.nodes.length }), 'done');
    if (node.type === 'handoff') return (await runUpdate(run, { status: 'paused', next: index, pause: true }), 'handoff');
    if (node.tag) await runUpdate(run, { tag: node.tag });
    const step = await buildStep(run, contact, node, index);
    if (!step) return (await runUpdate(run, { status: 'expired', next: index }), 'expired');
    await rest.rpc('instagram_automations_queue_step', { p_run: run.id, p_index: index, p_kind: step.kind, p_text: step.text,
      p_payload: step.payload, p_expires_at: step.expiresAt, p_links: step.links, p_waiting_hash: step.waitingHash, p_waiting_label: step.waitingLabel });
    return 'queued';
  }

  async function chosenButton(run, event) {
    const node = run.nodes[run.next_index];
    const buttons = node ? replyButtons(node) : [];
    if (event.buttonPayload) {
      const cut = event.buttonPayload.lastIndexOf(':');
      const base = event.buttonPayload.slice(0, cut);
      const id = event.buttonPayload.slice(cut + 1);
      return run.waiting_hash === (await sha256Hex(base)) ? buttons.find(button => button.id === id) || null : null;
    }
    if (event.kind === 'postback') return null;
    const typed = event.text.trim().toLocaleLowerCase('pt-BR');
    return buttons.find(button => button.title.toLocaleLowerCase('pt-BR') === typed) || null;
  }

  // A pessoa tocou (ou digitou) um botão de resposta de uma execução que esperava por ela.
  async function continueWaiting(waiting, event, contact) {
    for (const run of waiting) {
      const choice = await chosenButton(run, event);
      if (!choice) continue;
      const next = await rest.rpc('instagram_automations_choose_route', { p_run: run.id, p_expected_index: run.next_index,
        p_next_index: nextIndex(run.nodes, run.next_index, choice.id), p_button_id: choice.id, p_at: event.at });
      if (next) await advance(next, contact);
      return true;
    }
    return false;
  }

  async function startAutomation(claim, event, contact) {
    const active = await rest.rpc('instagram_automations_active', { p_account: claim.account_id });
    const candidates = active.filter(item => Date.parse(event.at) >= Date.parse(item.activated_at) && testAllows(item, contact.igsid)
      && matchesFlow(item.published, event)).sort((a, b) => flowPriority(b.published, event.text) - flowPriority(a.published, event.text));
    const chosen = candidates[0];
    if (!chosen) return 'no_match';
    const run = await rest.rpc('instagram_automations_start_run', { p_account: claim.account_id, p_contact: contact.id, p_automation: chosen.id,
      p_event: claim.id, p_nodes: chosen.published.nodes, p_comment_id: event.kind === 'comment' ? event.commentId : null,
      p_media_id: event.mediaId || null, p_live: !!event.live, p_per_automation: event.kind === 'comment' });
    if (!run) return 'limited';
    await advance(run, contact);
    return 'started';
  }

  async function fillProfile(claim, contact) {
    if (contact.username || !claim.token) return;
    try {
      const profile = await graph(claim.token).profile(contact.igsid);
      await rest.rpc('instagram_automations_set_profile', { p_contact: contact.id, p_username: profile.username, p_name: profile.name });
    } catch {
      // Nome e @ podem não estar disponíveis; o contato aparece sem eles.
    }
  }

  async function processEvent(claim) {
    const event = claim.event;
    if (event.kind === 'seen' || event.kind === 'deleted') {
      await rest.rpc('instagram_automations_mark_message', { p_account: claim.account_id, p_provider_id: event.providerId,
        p_status: event.kind === 'seen' ? 'read' : 'deleted' });
      return 'marked';
    }
    const contact = await rest.rpc('instagram_automations_touch_contact', { p_account: claim.account_id, p_igsid: event.scopedId,
      p_username: event.username || null, p_opens_window: OPENS_WINDOW.has(event.kind), p_at: event.at,
      p_preview: event.kind === 'echo' ? null : event.text.slice(0, 240) });
    if (event.kind === 'echo') {
      await rest.rpc('instagram_automations_record_echo', { p_account: claim.account_id, p_contact: contact.id, p_text: event.text, p_provider_id: event.providerId });
      return 'echo';
    }
    const inbound = await rest.rpc('instagram_automations_record_inbound', { p_account: claim.account_id, p_contact: contact.id,
      p_kind: event.kind, p_text: event.text, p_provider_id: event.providerId, p_payload: event.mediaId ? { media_id: event.mediaId, live: !!event.live } : null });
    if (!inbound) return 'duplicate';
    await fillProfile(claim, contact);
    if (contact.automation_paused) return 'paused';
    const state = await rest.rpc('instagram_automations_contact_state', { p_contact: contact.id });
    if (await continueWaiting(state.waiting, event, state.contact || contact)) return 'continued';
    return STARTS.has(event.kind) ? startAutomation(claim, event, state.contact || contact) : 'ignored';
  }

  // Motivo para não enviar agora, no formato [erro, estado da mensagem, estado da execução].
  function sendBlock({ message, contact, run, automation, account, token, sent_last_hour: sentLastHour }) {
    if (!token || account.status !== 'connected') return ['CONEXAO_INDISPONIVEL', 'cancelled', 'failed'];
    if (message.expires_at && Date.parse(message.expires_at) <= now()) return ['JANELA_ENCERRADA', 'cancelled', 'expired'];
    if (message.automated) {
      if (contact.automation_paused || run?.status === 'paused') return ['AUTOMACAO_PAUSADA_PARA_O_CONTATO', 'cancelled', 'paused'];
      if (!automation || automation.mode === 'off') return ['AUTOMACAO_DESLIGADA', 'cancelled', 'cancelled'];
      if (!testAllows(automation, contact.igsid)) return ['FORA_DO_TESTE', 'cancelled', 'cancelled'];
      if (sentLastHour >= HOURLY_LIMIT) return ['LIMITE_DE_100_POR_HORA', 'cancelled', 'failed'];
    }
    const commentKind = message.kind === 'private_reply' || message.kind === 'public_reply';
    const commentId = message.kind === 'private_reply' ? message.payload?.recipient?.comment_id : message.payload?.comment_id;
    if (commentKind && (!run || commentId !== run.comment_id)) return ['DESTINATARIO_INVALIDO', 'cancelled', 'failed'];
    if (!commentKind) {
      if (!contact.last_inbound_at || now() - Date.parse(contact.last_inbound_at) >= 24 * HOUR) return ['JANELA_ENCERRADA', 'cancelled', 'expired'];
      if (message.payload?.recipient?.id !== contact.igsid) return ['DESTINATARIO_INVALIDO', 'cancelled', 'failed'];
    }
    return null;
  }

  // O comentário precisa ser posterior à ativação, ter menos de 7 dias e ser da publicação certa (exceto live).
  async function commentStillValid(client, { run, automation }) {
    if (run.live) return true;
    const comment = await client.comment(run.comment_id);
    const created = Date.parse(comment.createdAt || '');
    const published = automation.published || {};
    return Number.isFinite(created) && created >= Date.parse(automation.activated_at) - 60000 && now() - created < 7 * 24 * HOUR
      && (published.media !== 'specific' || comment.mediaId === published.mediaId);
  }

  const finish = (claim, status, providerId, error, runStatus, next) => rest.rpc('instagram_automations_finish_outbound', {
    p_message: claim.message.id, p_status: status, p_provider_id: providerId, p_error: error,
    p_run_status: claim.run && claim.message.kind !== 'public_reply' ? runStatus : null, p_next_index: next ?? null });

  async function queuePublicReply(claim) {
    const options = publicReplyOptions(claim.automation?.published || {});
    if (!options.length || claim.run.live) return;
    const choices = options.length > 1 ? options.filter(text => text !== claim.last_public_reply) : options;
    await rest.rpc('instagram_automations_queue_public_reply', { p_run: claim.run.id, p_text: choices[Math.floor(random() * choices.length)] });
  }

  async function afterSend(claim, result) {
    const { message, contact, run } = claim;
    if (!run || message.kind === 'public_reply' || message.kind === 'manual') return finish(claim, 'accepted', result.messageId, null, null);
    if (message.kind === 'private_reply' && result.recipientId && result.recipientId !== contact.igsid) {
      // Pessoa diferente da esperada: nada mais é enviado nessa execução, e o caso fica para olhar.
      await finish(claim, 'accepted', result.messageId, 'DESTINATARIO_DIFERENTE', 'failed');
      await rest.rpc('instagram_automations_pause_contact', { p_contact: contact.id, p_paused: true });
      return null;
    }
    const waiting = !!run.waiting_hash;
    await finish(claim, 'accepted', result.messageId, null, waiting ? 'waiting' : 'ready', waiting ? null : nextIndex(run.nodes, run.next_index));
    if (message.kind === 'private_reply') await queuePublicReply(claim);
    if (waiting) return null;
    const fresh = await rest.rpc('instagram_automations_run', { p_run: run.id });
    return advance(fresh.run, fresh.contact);
  }

  async function recordFailure(claim, error) {
    const meta = error instanceof MetaError ? error : new MetaError('Envio sem confirmação.', { uncertain: true });
    const code = meta.code === 190 ? 'META_REAUTORIZAR' : windowClosed(meta) ? 'JANELA_ENCERRADA'
      : meta.code === 10 || meta.code === 200 ? 'META_PERMISSAO' : `META_${meta.code || meta.status || 'SEM_CONFIRMACAO'}`;
    const detail = meta.detail ? `${code}: ${meta.detail}` : code;
    await finish(claim, meta.uncertain ? 'unknown' : 'failed', null, detail, meta.uncertain ? 'uncertain' : 'failed').catch(() => null);
    if (meta.code === 190) await rest.rpc('instagram_automations_mark_expired', { p_account: claim.account.id, p_error: code }).catch(() => null);
  }

  async function sendOne() {
    const claim = await rest.rpc('instagram_automations_claim_outbound', { p_lease_seconds: 60 });
    if (!claim) return false;
    const blocked = sendBlock(claim);
    if (blocked) {
      await finish(claim, blocked[1], null, blocked[0], blocked[2]);
      return true;
    }
    try {
      const client = graph(claim.token);
      const { message } = claim;
      if (message.kind === 'private_reply' && !(await commentStillValid(client, claim))) {
        await finish(claim, 'cancelled', null, 'COMENTARIO_FORA_DO_PRAZO', 'failed');
        return true;
      }
      const result = message.kind === 'public_reply' ? await client.replyPublic(message.payload.comment_id, message.payload.text)
        : await client.sendMessage(claim.account.page_id, { recipient: message.payload.recipient, message: message.payload.message });
      await afterSend(claim, result);
    } catch (error) {
      await recordFailure(claim, error);
    }
    return true;
  }

  async function processEvents(deadline) {
    let processed = 0;
    while (now() < deadline && processed < 50) {
      const claim = await rest.rpc('instagram_automations_claim_event', { p_lease_seconds: 120 });
      if (!claim) break;
      try {
        await processEvent(claim);
        await rest.rpc('instagram_automations_finish_event', { p_event: claim.id, p_status: 'done', p_error: null });
      } catch (error) {
        await rest.rpc('instagram_automations_finish_event', { p_event: claim.id, p_status: 'retry', p_error: String(error?.message || error) }).catch(() => null);
      }
      processed++;
    }
    return processed;
  }

  async function sendQueue(deadline) {
    let sent = 0;
    while (now() < deadline && sent < 50 && (await sendOne())) sent++;
    return sent;
  }

  return { processEvent, processEvents, sendOne, sendQueue, advance, buildStep };
}
