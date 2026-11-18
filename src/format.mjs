// Textos curtos que a linha de comando mostra: datas no seu fuso, gatilhos, modos e publicações.
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';
export const TRIGGER_LABEL = { comment: 'comentário', direct: 'Direct', story_reply: 'resposta ao Story', story_mention: 'menção em Story' };
export const MODE_LABEL = { off: 'desligada', test: 'em teste', live: 'ativa' };
const MATCH_LABEL = { any: 'qualquer mensagem', contains: 'contém', exact: 'exatamente' };
const MEDIA_LABEL = { specific: 'na publicação escolhida', next: 'na próxima publicação', live: 'em qualquer live', all: 'em qualquer Story' };

export const shortId = id => String(id || '').slice(0, 8);
export const normalizeHandle = handle => String(handle || '').trim().replace(/^@/, '').toLowerCase();

export function checkTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone });
    return timeZone;
  } catch {
    throw new Error(`FUSO_HORARIO inválido no .env: ${timeZone}. Exemplo: America/Sao_Paulo.`);
  }
}

export function formatWhen(value, timeZone = DEFAULT_TIME_ZONE) {
  if (!value) return '';
  const format = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return format.format(new Date(value)).replace(', ', ' às ');
}

export function mediaKind(item) {
  if (item.product === 'STORY') return 'Story';
  if (item.product === 'REELS') return 'Reels';
  return { CAROUSEL_ALBUM: 'carrossel', VIDEO: 'vídeo', IMAGE: 'foto' }[item.type] || 'publicação';
}

export function describeMedia(item, timeZone) {
  const caption = String(item.caption || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  let line = `${item.id} · ${mediaKind(item)} · ${formatWhen(item.timestamp, timeZone)}${caption ? ` · "${caption}"` : ''}`;
  if (item.permalink) line += `\n    ${item.permalink}`;
  return line;
}

// Ex.: comentário na publicação escolhida, contém "guia" ou "quero".
export function describeTrigger(flow = {}) {
  const parts = [TRIGGER_LABEL[flow.trigger] || 'sem gatilho'];
  if (MEDIA_LABEL[flow.media] && ['comment', 'story_reply'].includes(flow.trigger)) parts.push(MEDIA_LABEL[flow.media]);
  const words = String(flow.keywords || '').split(/[,;\n]/).map(word => word.trim()).filter(Boolean);
  if (flow.trigger !== 'story_mention') {
    parts.push(flow.match === 'any' || !words.length ? 'com qualquer mensagem' : `${MATCH_LABEL[flow.match] || ''} ${words.map(word => `"${word}"`).join(' ou ')}`);
  }
  return parts.join(', ').replace(/, com/, ' com');
}

export function describeAutomation(item, timeZone) {
  const flow = item.draft || {};
  const pending = item.changed_since_publish ? ' (com mudanças ainda não publicadas)' : '';
  const lines = [`${shortId(item.id)} · ${MODE_LABEL[item.mode] || item.mode}${pending} · "${flow.name || 'sem nome'}"`, `    ${describeTrigger(flow)}`];
  const metrics = item.metrics || {};
  if (metrics.runs) {
    const clicks = metrics.with_links ? `, ${metrics.clicked} de ${metrics.with_links} clicaram no link` : '';
    lines.push(`    ${metrics.contacts} pessoa(s), ${metrics.sent} mensagem(ns) enviada(s)${clicks}, última em ${formatWhen(metrics.last_run_at, timeZone)}`);
  }
  if (item.mode === 'test') lines.push(`    Só responde a: ${(item.test_recipients || []).join(', ')}`);
  return lines.join('\n');
}

export function describeContact(contact, timeZone) {
  const who = contact.username ? `@${contact.username}` : 'sem @';
  const name = contact.name ? ` (${contact.name})` : '';
  const paused = contact.automation_paused ? ' · automação pausada' : '';
  const last = contact.last_message_at ? ` · ${formatWhen(contact.last_message_at, timeZone)}` : '';
  const preview = contact.preview ? ` · "${String(contact.preview).slice(0, 60)}"` : '';
  return `${who}${name} · ${contact.igsid}${last}${paused}${preview}`;
}

const DIRECTION = { in: '←', out: '→' };
const KIND_LABEL = { comment: 'comentário', direct: 'Direct', story_reply: 'resposta ao Story', story_mention: 'menção em Story',
  postback: 'botão', echo: 'pelo app do Instagram', private_reply: 'resposta privada', text: 'mensagem', public_reply: 'resposta pública',
  manual: 'resposta manual' };
const STATUS_LABEL = { queued: 'na fila', sending: 'enviando', unknown: 'sem confirmação da Meta', failed: 'falhou', cancelled: 'cancelada',
  deleted: 'apagada' };

export function describeMessage(message, timeZone) {
  const who = message.direction === 'in' ? 'pessoa' : message.automated ? 'automação' : 'você';
  const label = STATUS_LABEL[message.status];
  const status = message.direction === 'out' && label ? ` [${label}${message.error ? `: ${message.error}` : ''}]` : '';
  return `${formatWhen(message.created_at, timeZone)} ${DIRECTION[message.direction] || '·'} ${who}, ${KIND_LABEL[message.kind] || message.kind}: `
    + `${message.text || '—'}${status}`;
}
