// Modelo das automações: validar, compilar, casar com um evento e decidir a prioridade.
// Mesmas regras do quadro de origem: um gatilho, até 20 blocos, até 3 botões por mensagem, sem ciclos.

export const TRIGGERS = ['comment', 'direct', 'story_reply', 'story_mention'];
const MATCHES = ['any', 'contains', 'exact'];
const ID = /^[\w-]{1,40}$/;
const IG_ID = /^[0-9]{5,40}$/;

export class FlowError extends Error {}
const fail = message => { throw new FlowError(message); };

export const normalizeText = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
export const keywordList = flow => String(flow.keywords || '').split(/[,;\n]/).map(normalizeText).filter(Boolean);
export const publicReplyOptions = flow => [...new Set((flow.publicReplies || []).map(item => String(item).trim()).filter(Boolean))];
export const replyButtons = node => (node.buttons || []).filter(button => button.type === 'reply');
export const linkButtons = node => (node.buttons || []).filter(button => button.type === 'link');

const PLACEHOLDER_HOST = /(^|\.)exemplo\.com$/i;

function checkHttps(value) {
  let url;
  try {
    url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch {
    fail('Use um link HTTPS sem usuário e senha no endereço.');
  }
  if (PLACEHOLDER_HOST.test(url.hostname)) fail('Troque o link de exemplo (exemplo.com) pelo seu link de verdade.');
}

function checkTrigger(flow) {
  if (!TRIGGERS.includes(flow.trigger)) fail('Escolha o gatilho: comentário, Direct, resposta a Story ou menção em Story.');
  if (!MATCHES.includes(flow.match)) fail('Escolha como as palavras disparam: qualquer mensagem, contém ou exata.');
  if (flow.trigger === 'comment' && !['specific', 'next', 'live'].includes(flow.media)) {
    fail('Escolha a publicação, a próxima publicação ou qualquer live.');
  }
  if (flow.trigger === 'comment' && flow.media === 'specific' && !IG_ID.test(flow.mediaId || '')) fail('Escolha a publicação (no quadro, pela miniatura; na linha de comando, o id de npm run posts).');
  if (flow.trigger === 'story_reply' && !['all', 'specific'].includes(flow.media)) fail('Escolha um Story ou qualquer Story.');
  if (flow.trigger === 'story_reply' && flow.media === 'specific' && !IG_ID.test(flow.mediaId || '')) fail('Escolha o Story (no quadro, pela miniatura; na linha de comando, o id de npm run posts -- --stories).');
  if (flow.match !== 'any' && !keywordList(flow).length) fail('Informe ao menos uma palavra para iniciar a automação.');
  const replies = publicReplyOptions(flow);
  if (replies.length > 20 || replies.some(reply => reply.length > 1000)) fail('Use até 20 respostas públicas de até 1.000 caracteres.');
}

function checkBlock(block, ids) {
  if (!ID.test(block.id || '')) fail('Bloco sem identificador.');
  if (block.type === 'handoff') return;
  const buttons = block.buttons || [];
  const text = String(block.text || '').trim();
  if (!text || text.length > (buttons.length ? 640 : 1000)) fail('Mensagem vazia ou longa demais para o Instagram (até 640 caracteres com botões).');
  if (buttons.length > 3) fail('Use até três botões por mensagem.');
  if (new Set(buttons.map(button => button.id)).size !== buttons.length) fail('Há botões repetidos na mesma mensagem.');
  if (new Set(buttons.map(button => normalizeText(button.title))).size !== buttons.length) fail('Use títulos diferentes nos botões.');
  for (const button of buttons) {
    if (!ID.test(button.id || '') || !['reply', 'link'].includes(button.type)) fail('Botão inválido.');
    if (!String(button.title || '').trim() || button.title.length > 20) fail('Use um título de botão com até 20 caracteres.');
    if (button.type === 'link') checkHttps(button.url);
    if (button.type === 'reply' && !ids.has(button.target)) fail(`Ligue o botão “${button.title}” a uma mensagem.`);
  }
  if (replyButtons(block).length && block.next) fail('Mensagem com botão de resposta segue pelo botão, não por "depois".');
  if (block.next && !ids.has(block.next)) fail('Uma ligação aponta para uma mensagem que não existe.');
  if (block.tag && String(block.tag).length > 80) fail('A etiqueta tem até 80 caracteres.');
}

function checkComment(first) {
  if (first.type === 'handoff') fail('Depois de um comentário, a primeira etapa precisa ser uma mensagem.');
  if (!replyButtons(first).length && first.next) {
    fail('Para continuar depois do comentário, inclua um botão de resposta na primeira mensagem.');
  }
  if (replyButtons(first).length && linkButtons(first).length) {
    fail('Na primeira mensagem depois de um comentário, use botões de resposta; coloque os links na mensagem seguinte.');
  }
}

// Ordem de execução a partir do primeiro bloco, sem ciclos e sem blocos soltos.
function order(blocks) {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const visited = new Set();
  const visiting = new Set();
  const sorted = [];
  const visit = id => {
    if (visiting.has(id)) fail('A automação tem um ciclo: uma mensagem volta para outra anterior.');
    if (visited.has(id)) return;
    const block = byId.get(id);
    visiting.add(id);
    sorted.push(block);
    for (const target of [...replyButtons(block).map(button => button.target), block.next].filter(Boolean)) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  visit(blocks[0].id);
  if (visited.size !== blocks.length) fail('Ligue todas as mensagens à primeira, pelos botões ou por "depois".');
  return sorted;
}

// Valida o rascunho e devolve a versão publicável, com os blocos na ordem de execução.
export function compileFlow(flow) {
  checkTrigger(flow);
  const blocks = Array.isArray(flow.blocks) ? flow.blocks : [];
  if (!blocks.length || blocks.length > 20) fail('Use de 1 a 20 mensagens.');
  const ids = new Set(blocks.map(block => block.id));
  if (ids.size !== blocks.length) fail('Há mensagens com o mesmo identificador.');
  for (const block of blocks) checkBlock(block, ids);
  if (flow.trigger === 'comment') checkComment(blocks[0]);
  const nodes = order(blocks).map(block => ({
    id: block.id, type: block.type === 'handoff' ? 'handoff' : 'message', text: String(block.text || '').trim(),
    buttons: (block.buttons || []).map(({ id, type, title, url, target }) => ({ id, type, title: title.trim(), ...(type === 'link' ? { url } : { target }) })),
    next: replyButtons(block).length ? null : block.next || null, ...(block.tag ? { tag: String(block.tag).trim() } : {}),
  }));
  return { ...flow, mediaId: flow.media === 'specific' ? flow.mediaId : null, nodes };
}

export function nextIndex(nodes, index, buttonId) {
  const node = nodes[index];
  if (!node) return nodes.length;
  const target = buttonId ? node.buttons?.find(button => button.id === buttonId)?.target : node.next;
  if (!target) return nodes.length;
  const found = nodes.findIndex(item => item.id === target);
  return found < 0 ? nodes.length : found;
}

export function matchesFlow(flow, event) {
  if (flow.trigger !== event.kind) return false;
  if (flow.trigger === 'comment') {
    if (flow.media === 'next') return false;
    if (flow.media === 'live' && !event.live) return false;
    if (flow.media === 'specific' && (event.live || flow.mediaId !== event.mediaId)) return false;
  }
  if (flow.trigger === 'story_reply' && flow.media === 'specific' && flow.mediaId !== event.mediaId) return false;
  const text = normalizeText(event.text);
  return flow.match === 'any' || keywordList(flow).some(word => (flow.match === 'exact' ? text === word : text.includes(word)));
}

// Publicação específica primeiro, depois palavra exata e mais longa.
export function flowPriority(flow, text) {
  const normalized = normalizeText(text);
  const length = Math.max(0, ...keywordList(flow).filter(word => (flow.match === 'exact' ? normalized === word : normalized.includes(word)))
    .map(word => word.length));
  return (flow.media === 'specific' ? 100000 : 0) + (flow.match === 'exact' ? 10000 : flow.match === 'contains' ? 1000 : 0) + length;
}

const scope = flow => (flow.media === 'specific' ? flow.mediaId : 'any');

// Duas automações ativas não podem atender ao mesmo ponto de entrada com palavras que se cruzam.
export function sharesEntryPoint(first, second) {
  if (first.trigger !== second.trigger) return false;
  if (first.trigger === 'story_reply' && scope(first) !== 'any' && scope(second) !== 'any' && scope(first) !== scope(second)) return false;
  if (first.trigger === 'comment') {
    if (['next', 'live'].includes(first.media) || ['next', 'live'].includes(second.media)) return first.media === second.media;
    if (first.mediaId !== second.mediaId) return false;
  }
  if (first.match === 'any' || second.match === 'any') return first.match === second.match;
  return keywordList(first).some(a => keywordList(second).some(b => (first.match === 'exact' && second.match === 'exact' ? a === b
    : first.match === 'exact' ? a.includes(b) : second.match === 'exact' ? b.includes(a) : a.includes(b) || b.includes(a))));
}

export function testAllows(automation, igsid) {
  return automation.mode === 'live' || (automation.mode === 'test' && (automation.test_recipients || []).includes(igsid));
}
