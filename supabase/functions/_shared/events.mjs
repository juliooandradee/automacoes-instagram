// Transforma o que a Meta manda (webhook) e o que a busca de comentários encontra em eventos de um formato só.
// Guarda apenas campos conhecidos: nada de URLs arbitrárias, chaves ou instruções do provedor.
import { sha256Hex } from './rest.mjs';

const numeric = value => typeof value === 'string' && /^\d{5,40}$/.test(value);
const text = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');

function timestamp(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number < 1e11 ? number * 1000 : number;
  if (ms > Date.now() + 5 * 60000 || ms < Date.UTC(2015, 0, 1)) return null;
  return new Date(ms).toISOString();
}

// Um comentário pode chegar duas vezes (comments e live_comments): fica um evento só, e o de live prevalece.
// O de live tem chave própria para não ser descartado como cópia de um aviso comum gravado antes.
function commentEvents(entry) {
  const comments = new Map();
  const changes = Array.isArray(entry.changes) ? entry.changes : entry.field ? [entry] : [];
  for (const change of changes) {
    const value = change?.value;
    const at = timestamp(entry.time) || new Date().toISOString();
    const commentId = String(value?.id || value?.comment_id || '');
    const live = change.field === 'live_comments' || value?.media?.media_product_type === 'LIVE';
    const valid = (change.field === 'comments' || change.field === 'live_comments') && numeric(commentId)
      && numeric(value?.from?.id) && value.from.id !== entry.id && numeric(value?.media?.id) && !value?.media?.ad_id;
    if (!valid) continue;
    const seen = comments.get(commentId);
    if (seen) {
      if (live && !seen.live) Object.assign(seen, { live: true, key: `live:${commentId}` });
      continue;
    }
    comments.set(commentId, {
      account: entry.id, key: `${live ? 'live' : 'comment'}:${commentId}`, kind: 'comment', scopedId: value.from.id, text: text(value.text),
      username: text(value.from.username, 30).toLowerCase(), commentId, providerId: commentId, mediaId: value.media.id, at,
      ...(live ? { live: true } : {}),
    });
  }
  return [...comments.values()];
}

function messagingKind(message, outbound) {
  if (message.read?.mid && !outbound) return ['seen', text(message.read.mid, 1000)];
  if (message.postback?.mid && !outbound) return ['postback', text(message.postback.mid, 1000)];
  if (!message.message?.mid) return [null, ''];
  const body = message.message;
  const kind = body.is_deleted ? 'deleted'
    : outbound || body.is_echo ? 'echo'
      : body.reply_to?.story ? 'story_reply'
        : body.attachments?.some(item => item.type === 'story_mention') ? 'story_mention' : 'direct';
  return [kind, text(body.mid, 1000)];
}

async function messagingEvent(entry, message) {
  const at = timestamp(message?.timestamp);
  if (!at || !numeric(message?.sender?.id) || !numeric(message?.recipient?.id)) return null;
  const outbound = message.sender.id === entry.id;
  if (!outbound && message.recipient.id !== entry.id) return null;
  const scopedId = outbound ? message.recipient.id : message.sender.id;
  if (scopedId === entry.id || message.message?.is_self) return null;
  const [kind, providerId] = messagingKind(message, outbound);
  if (!kind) return null;
  const body = message.message || {};
  const buttonPayload = kind === 'postback' ? text(message.postback.payload, 1000) : text(body.quick_reply?.payload, 1000);
  const content = kind === 'postback' ? text(message.postback.title)
    : body.is_deleted ? 'Mensagem removida no Instagram.'
      : text(body.text) || (body.attachments?.length ? '[Mídia recebida. Abra no Instagram para ver.]' : '[Mensagem não compatível]');
  const storyId = kind === 'story_reply' ? String(body.reply_to?.story?.id || '') : '';
  const group = ['echo', 'direct', 'story_reply', 'story_mention'].includes(kind) ? 'message' : kind;
  return {
    account: entry.id, key: `${group}:${await sha256Hex(providerId + (kind === 'postback' ? buttonPayload : ''))}`,
    kind, scopedId, text: kind === 'seen' ? '' : content, providerId, at,
    ...(buttonPayload ? { buttonPayload } : {}), ...(numeric(storyId) ? { mediaId: storyId } : {}),
  };
}

export async function normalizeWebhook(body) {
  const events = [];
  for (const envelope of Array.isArray(body) ? body : [body]) {
    if (envelope?.object !== 'instagram' || !Array.isArray(envelope.entry)) continue;
    for (const entry of envelope.entry) {
      if (!numeric(entry?.id)) continue;
      events.push(...commentEvents(entry));
      for (const message of Array.isArray(entry.messaging) ? entry.messaging : []) {
        const event = await messagingEvent(entry, message);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

// Comentário encontrado pela busca a cada minuto: mesmo formato e mesma chave do webhook, então não duplica.
export function polledCommentEvent(igUserId, mediaId, comment, live = false) {
  if (!comment.fromId || comment.fromId === igUserId) return null;
  return {
    account: igUserId, key: `${live ? 'live' : 'comment'}:${comment.id}`, kind: 'comment', scopedId: comment.fromId, text: comment.text,
    username: comment.username || '', commentId: comment.id, providerId: comment.id, mediaId, at: comment.timestamp,
    ...(live ? { live: true } : {}),
  };
}

// Resumo do lote para o registro da função: só nomes de campos, sem texto nem ids.
export function describeWebhook(body) {
  const parts = [];
  for (const envelope of Array.isArray(body) ? body : [body]) {
    for (const entry of Array.isArray(envelope?.entry) ? envelope.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) parts.push(String(change?.field || '?').slice(0, 40));
      if (Array.isArray(entry?.messaging)) parts.push(`messaging×${entry.messaging.length}`);
    }
  }
  return parts.join(' ') || 'vazio';
}
