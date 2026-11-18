// Quadro das automações. Roda só no seu computador (npm run quadro): fala com o servidor local,
// que repassa cada pedido à função do seu Supabase com a chave secreta. Nada aqui guarda chave ou senha.
const $ = selector => document.querySelector(selector);
const state = { account: 'principal', status: null, list: [], archived: false, editing: null, dirty: false, check: null,
  media: null, contacts: [], contact: null, thread: null, search: '' };

// ---------- utilidades ----------
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (['value', 'checked', 'disabled'].includes(key)) element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// Troca o conteúdo de um elemento, ignorando partes vazias (null, false).
function fill(element, ...children) {
  element.replaceChildren(...children.flat(Infinity).filter(child => child != null && child !== false));
  return element;
}

// Lista de escolha: options = [[valor, rótulo], ...].
function choice(options, value, onChange, attrs = {}) {
  const select = h('select', { ...attrs, onchange: event => onChange(event.target.value) },
    options.map(([key, label]) => h('option', { value: key }, label)));
  select.value = value ?? '';
  return select;
}

async function api(action, body = {}) {
  const response = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: state.account, ...body, action }) });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) throw new Error(data?.error || `A função respondeu com o código ${response.status}.`);
  return data;
}

let toastTimer;
function toast(message, bad = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = bad ? 'toast bad' : 'toast';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, bad ? 8000 : 3500);
}

async function attempt(task, success) {
  try {
    const result = await task();
    if (success) toast(success);
    return result ?? true;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
}

const fmt = value => (value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '');
const uid = prefix => `${prefix}${Math.random().toString(36).slice(2, 8)}`;
const debounce = (fn, ms) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; };

// ---------- textos ----------
const MODE = { off: ['desligada', ''], test: ['em teste', 'test'], live: ['ativa', 'live'] };
const TRIGGERS = [['comment', 'Comentário em post, Reels ou live'], ['direct', 'Mensagem no Direct'], ['story_reply', 'Resposta a um Story'],
  ['story_mention', 'Menção em Story']];
const MATCHES = [['contains', 'Contém uma das palavras'], ['exact', 'É exatamente a palavra'], ['any', 'Qualquer mensagem']];
const WHERE = {
  comment: [['specific', 'Uma publicação ou Reels que eu escolher'], ['next', 'A próxima publicação que eu fizer'], ['live', 'Qualquer live']],
  story_reply: [['all', 'Qualquer Story'], ['specific', 'Um Story que eu escolher']],
};
const INCOMING = { comment: 'comentário', direct: 'mensagem no Direct', story_reply: 'resposta ao Story', story_mention: 'menção no Story' };
const KIND_IN = { comment: 'comentário', direct: 'Direct', story_reply: 'resposta ao Story', story_mention: 'menção em Story', postback: 'tocou no botão' };
const STATUS = { queued: 'na fila', sending: 'enviando', unknown: 'sem confirmação da Meta', failed: 'falhou', cancelled: 'cancelada', deleted: 'apagada' };
const DEFAULT_PUBLIC = ['Te chamei no Direct!', 'Te mandei uma mensagem no Direct!', 'Oi! Te chamei no Direct.', 'Já te mandei uma mensagem no privado!',
  'Dá uma olhadinha no seu Direct!', 'Te enviei uma mensagem por lá!', 'Confere suas mensagens, te chamei!', 'Acabei de te chamar no privado.'];

// ---------- modelos ----------
const message = (text, buttons = [], extra = {}) => ({ id: uid('b'), type: 'message', text, buttons, next: null, tag: '', ...extra });
const replyButton = (title, target) => ({ id: uid('r'), type: 'reply', title, target });
const linkButton = title => ({ id: uid('l'), type: 'link', title, url: '' });

function twoStep(firstText, buttonTitle) {
  const second = message('Aqui está! Qualquer dúvida, é só responder esta mensagem.', [linkButton('Abrir o link')], { tag: 'recebeu-link' });
  return [message(firstText, [replyButton(buttonTitle, second.id)]), second];
}

const TEMPLATES = [
  { title: 'Comentou a palavra, recebe no Direct', text: 'Quem comentar QUERO no post ou Reels recebe o link no Direct.',
    build: () => ({ name: 'Comente QUERO', trigger: 'comment', media: 'specific', match: 'contains', keywords: 'quero', publicReplies: DEFAULT_PUBLIC.slice(0, 5),
      blocks: twoStep('Oi! Que bom que você comentou. Toque no botão que eu te mando o link aqui.', 'Quero o link') }) },
  { title: 'Próxima publicação', text: 'O mesmo, já pronto para o próximo post ou Reels que você publicar.',
    build: () => ({ name: 'Próximo post · comente QUERO', trigger: 'comment', media: 'next', match: 'contains', keywords: 'quero',
      publicReplies: DEFAULT_PUBLIC.slice(0, 5), blocks: twoStep('Oi! Que bom que você comentou. Toque no botão que eu te mando o link aqui.', 'Quero o link') }) },
  { title: 'Comentário na live', text: 'Quem comentar a palavra durante a live recebe a mensagem no Direct.',
    build: () => ({ name: 'Live · comente EU QUERO', trigger: 'comment', media: 'live', match: 'contains', keywords: 'eu quero', publicReplies: [],
      blocks: twoStep('Oi! Vi seu comentário na live. Toque no botão que eu te mando o link aqui.', 'Quero o link') }) },
  { title: 'Palavra no Direct', text: 'Quem mandar GUIA no Direct recebe o material na hora.',
    build: () => ({ name: 'Direct · GUIA', trigger: 'direct', match: 'contains', keywords: 'guia', publicReplies: [],
      blocks: [message('Oi! Aqui está o guia que você pediu.', [linkButton('Abrir o guia')], { tag: 'pediu-guia' })] }) },
  { title: 'Resposta a Story', text: 'Quem responder seu Story recebe uma mensagem e um link.',
    build: () => ({ name: 'Resposta ao Story', trigger: 'story_reply', media: 'all', match: 'any', keywords: '', publicReplies: [],
      blocks: [message('Obrigado por responder! Separei este link para você.', [linkButton('Abrir o link')])] }) },
  { title: 'Menção em Story', text: 'Agradece quem marcar seu perfil em um Story.',
    build: () => ({ name: 'Agradecer menção', trigger: 'story_mention', match: 'any', keywords: '', publicReplies: [],
      blocks: [message('Obrigado por compartilhar! Fiquei muito feliz com a menção.')] }) },
  { title: 'Em branco', text: 'Comece do zero.',
    build: () => ({ name: 'Nova automação', trigger: 'direct', match: 'contains', keywords: '', publicReplies: [], blocks: [message('')] }) },
];

function normalizeDraft(draft = {}) {
  const blocks = (Array.isArray(draft.blocks) && draft.blocks.length ? draft.blocks : [message('')])
    .map(block => ({ ...block, type: block.type === 'handoff' ? 'handoff' : 'message', text: block.text || '', tag: block.tag || '',
      next: block.next || null, buttons: Array.isArray(block.buttons) ? block.buttons.map(button => ({ ...button })) : [] }));
  return { name: draft.name || '', trigger: draft.trigger || 'direct', media: draft.media ?? null, mediaId: draft.mediaId || null,
    mediaPreview: draft.mediaPreview || null, match: draft.match || 'contains', keywords: draft.keywords || '',
    publicReplies: Array.isArray(draft.publicReplies) ? draft.publicReplies : [], blocks };
}

// ---------- abas ----------
function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.tab === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('.panel')) section.hidden = section.id !== `tab-${name}`;
  if (name === 'automacoes' && !state.editing) loadAutomations();
  if (name === 'conversas') loadInbox();
  if (name === 'conexao') loadConnection();
}

function renderWho() {
  const who = $('#who');
  const accounts = state.status?.accounts || [];
  const account = accounts.find(item => item.account === state.account);
  const label = account?.status === 'connected' ? h('span', {}, h('b', {}, `@${account.username}`), ' conectado')
    : h('span', {}, 'Instagram não conectado');
  if (accounts.length < 2) return fill(who, label);
  const select = choice(accounts.map(item => [item.account, item.username ? `@${item.username}` : item.account]), state.account, value => {
    state.account = value;
    state.editing = null;
    showTab(document.querySelector('.tab[aria-current]')?.dataset.tab || 'automacoes');
  }, { 'aria-label': 'Conta' });
  return fill(who, select);
}

// ---------- lista de automações ----------
async function loadAutomations() {
  const list = await attempt(() => api('automations', { archived: state.archived }));
  if (Array.isArray(list)) state.list = list;
  renderList();
}

function triggerText(flow = {}) {
  const trigger = TRIGGERS.find(([key]) => key === flow.trigger)?.[1] || 'Sem gatilho';
  const where = WHERE[flow.trigger]?.find(([key]) => key === flow.media)?.[1];
  const words = String(flow.keywords || '').split(/[,;\n]/).map(word => word.trim()).filter(Boolean);
  const match = flow.trigger === 'story_mention' ? '' : flow.match === 'any' || !words.length ? ' · qualquer mensagem'
    : ` · ${flow.match === 'exact' ? 'exatamente' : 'contém'} ${words.map(word => `“${word}”`).join(' ou ')}`;
  return `${trigger}${where ? ` · ${where.toLowerCase()}` : ''}${match}`;
}

function automationCard(item) {
  const [label, kind] = MODE[item.mode] || [item.mode, ''];
  const metrics = item.metrics || {};
  const open = () => openEditor(item);
  return h('article', { class: 'card auto-card', tabindex: 0, role: 'button', onclick: open,
    onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } } },
  h('div', { class: 'row' }, h('span', { class: `pill ${kind}` }, label),
    item.changed_since_publish ? h('span', { class: 'pill warn' }, 'mudanças não publicadas') : null),
  h('h2', {}, item.draft?.name || 'Sem nome'),
  h('p', { class: 'muted small' }, triggerText(item.draft)),
  h('div', { class: 'metrics' }, h('span', {}, h('b', {}, metrics.contacts ?? 0), ' pessoas'), h('span', {}, h('b', {}, metrics.sent ?? 0), ' enviadas'),
    metrics.with_links ? h('span', {}, h('b', {}, `${Math.round((metrics.clicked / metrics.with_links) * 100)}%`), ' clicaram no link') : null));
}

function renderList() {
  const connected = state.status?.accounts?.some(item => item.account === state.account && item.status === 'connected');
  const empty = h('div', { class: 'card empty' }, state.archived ? 'A lixeira está vazia.'
    : 'Nenhuma automação ainda. Clique em “Nova automação” e escolha um modelo.');
  fill($('#tab-automacoes'), 
    connected ? null : h('div', { class: 'card check bad' }, 'O Instagram não está conectado. Vá em Conexão (ou rode npm run conectar) antes de ativar.'),
    h('div', { class: 'bar' }, h('h1', { class: 'grow' }, state.archived ? 'Lixeira' : 'Automações'),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.archived = !state.archived; loadAutomations(); } },
        state.archived ? '← Voltar' : 'Lixeira'),
      state.archived ? null : h('button', { class: 'btn primary', type: 'button', onclick: renderTemplates }, '+ Nova automação')),
    state.list.length ? h('div', { class: 'grid' }, state.list.map(automationCard)) : empty);
}

function renderTemplates() {
  fill($('#tab-automacoes'), 
    h('div', { class: 'bar' }, h('button', { class: 'btn', type: 'button', onclick: renderList }, '← Voltar'), h('h1', { class: 'grow' }, 'Nova automação')),
    h('p', { class: 'muted' }, 'Escolha um ponto de partida. Tudo pode ser mudado depois.'),
    h('div', { class: 'templates' }, TEMPLATES.map(template => h('button', { class: 'card template', type: 'button',
      onclick: () => openEditor({ id: null, mode: 'off', revision: null, test_recipients: [], draft: template.build() }) },
    h('strong', {}, template.title), h('span', { class: 'muted small' }, template.text)))));
}

// ---------- editor ----------
function openEditor(item) {
  state.editing = { ...structuredClone(item), draft: normalizeDraft(structuredClone(item.draft)) };
  state.dirty = !item.id;
  state.check = null;
  state.media = null;
  renderEditor();
  validateSoon();
}

function leaveEditor() {
  if (state.dirty && !confirm('Sair sem salvar as mudanças?')) return;
  state.editing = null;
  state.dirty = false;
  loadAutomations();
}

function renderEditor() {
  const editing = state.editing;
  const draft = editing.draft;
  fill($('#tab-automacoes'), 
    h('div', { class: 'bar' }, h('button', { class: 'btn', type: 'button', onclick: leaveEditor }, '← Automações'),
      h('input', { type: 'text', class: 'grow', value: draft.name, maxlength: 120, placeholder: 'Nome da automação', 'aria-label': 'Nome da automação',
        oninput: event => change(value => { value.name = event.target.value; }) })),
    h('div', { class: 'editor' },
      h('div', { class: 'stack' }, triggerCard(draft), wordsCard(draft), publicCard(draft), blocksCard(draft)),
      h('aside', { class: 'side' }, statusCard(editing), previewCard(draft))));
}

function renderSide() {
  const side = document.querySelector('.editor .side');
  if (side && state.editing) fill(side, statusCard(state.editing), previewCard(state.editing.draft));
}

// Aplica a mudança no rascunho; redesenha tudo só quando a estrutura muda (para não perder o cursor ao digitar).
function change(mutate, rerender = false) {
  mutate(state.editing.draft);
  state.dirty = true;
  if (rerender) renderEditor();
  else renderSide();
  validateSoon();
}

const validateSoon = debounce(async () => {
  if (!state.editing) return;
  try {
    await api('validate', { draft: state.editing.draft });
    state.check = { ok: true };
  } catch (error) {
    state.check = { ok: false, error: error.message };
  }
  renderSide();
}, 400);

function setTrigger(draft, trigger) {
  draft.trigger = trigger;
  draft.media = WHERE[trigger]?.[0][0] || null;
  draft.mediaId = null;
  draft.mediaPreview = null;
  if (trigger === 'story_mention') draft.match = 'any';
  if (trigger !== 'comment') draft.publicReplies = [];
  state.media = null;
}

function triggerCard(draft) {
  const where = WHERE[draft.trigger];
  return h('div', { class: 'card stack' }, h('h2', {}, 'Quando começar'),
    h('label', { class: 'field' }, 'Gatilho', choice(TRIGGERS, draft.trigger, value => change(item => setTrigger(item, value), true))),
    where ? h('label', { class: 'field' }, 'Onde', choice(where, draft.media, value => change(item => {
      item.media = value;
      item.mediaId = null;
      item.mediaPreview = null;
      if (value === 'live') item.publicReplies = [];
    }, true))) : null,
    mediaField(draft));
}

const NOTES = {
  next: 'Quando você publicar o próximo post ou Reels, a automação passa a valer só para ele.',
  live: 'Vale durante a transmissão: o Instagram só deixa responder no privado enquanto a live está no ar. Não há resposta pública na live.',
};

function mediaField(draft) {
  if (draft.media !== 'specific') return NOTES[draft.media] ? h('p', { class: 'muted small' }, NOTES[draft.media]) : null;
  const preview = draft.mediaPreview;
  const chosen = draft.mediaId ? h('div', { class: 'chosen' },
    preview?.thumbnailUrl ? h('img', { src: preview.thumbnailUrl, alt: '', referrerpolicy: 'no-referrer', onerror: event => event.target.remove() }) : null,
    h('div', { class: 'stack' }, h('span', {}, preview?.caption || `Publicação ${draft.mediaId}`),
      preview?.permalink ? h('a', { href: preview.permalink, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Ver no Instagram') : null))
    : h('p', { class: 'muted small' }, 'Nenhuma escolhida ainda.');
  const kind = draft.trigger === 'story_reply' ? 'stories' : 'media';
  return h('div', { class: 'stack' }, chosen,
    h('button', { class: 'btn', type: 'button', onclick: () => loadMedia(kind) }, draft.mediaId ? 'Trocar' : kind === 'stories' ? 'Escolher Story' : 'Escolher publicação'),
    state.media?.kind === kind ? mediaGrid(draft) : null);
}

async function loadMedia(kind, after) {
  const result = await attempt(() => api(kind, { after }));
  if (!result || result === true) return;
  if (result.warning) toast(result.warning, true);
  const previous = after && state.media?.kind === kind ? state.media.items : [];
  state.media = { kind, items: [...previous, ...result.items], after: result.after || null };
  renderEditor();
}

function mediaLabel(item) {
  if (item.product === 'STORY') return 'Story';
  if (item.product === 'REELS') return 'Reels';
  return { CAROUSEL_ALBUM: 'carrossel', VIDEO: 'vídeo', IMAGE: 'foto' }[item.type] || 'post';
}

function mediaGrid(draft) {
  const { items, after, kind } = state.media;
  if (!items.length) return h('p', { class: 'muted small' }, kind === 'stories' ? 'Nenhum Story no ar agora.' : 'Nenhuma publicação encontrada.');
  const pick = item => change(value => {
    value.mediaId = item.id;
    value.mediaPreview = { thumbnailUrl: item.thumbnailUrl, caption: String(item.caption || '').slice(0, 120), permalink: item.permalink,
      type: item.type, product: item.product, timestamp: item.timestamp };
    state.media = null;
  }, true);
  return h('div', { class: 'stack' },
    h('div', { class: 'media-grid' }, items.map(item => h('button', { class: 'media', type: 'button', title: item.caption || mediaLabel(item),
      'aria-pressed': String(item.id === draft.mediaId), onclick: () => pick(item) },
    item.thumbnailUrl ? h('img', { src: item.thumbnailUrl, alt: item.caption ? item.caption.slice(0, 80) : mediaLabel(item), loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('em', {}, String(item.caption || '').slice(0, 70)),
    h('span', {}, `${mediaLabel(item)} · ${fmt(item.timestamp).split(',')[0]}`)))),
    after ? h('button', { class: 'btn link', type: 'button', onclick: () => loadMedia(kind, after) }, 'Carregar mais antigas') : null);
}

function wordsCard(draft) {
  if (draft.trigger === 'story_mention') {
    return h('div', { class: 'card stack' }, h('h2', {}, 'Palavras'), h('p', { class: 'muted small' }, 'Toda menção ao seu perfil em um Story dispara.'));
  }
  const words = h('label', { class: 'field' }, 'Palavras', h('span', { class: 'hint' }, 'Separe por vírgula. Acentos e maiúsculas não importam.'),
    h('input', { type: 'text', value: draft.keywords, maxlength: 1000, placeholder: 'quero, eu quero, link',
      oninput: event => change(value => { value.keywords = event.target.value; }) }));
  return h('div', { class: 'card stack' }, h('h2', {}, 'Palavras que disparam'),
    h('label', { class: 'field' }, 'Quando a mensagem', choice(MATCHES, draft.match, value => change(item => { item.match = value; }, true))),
    draft.match === 'any' ? h('p', { class: 'muted small' }, draft.trigger === 'comment' ? 'Qualquer comentário dispara.' : 'Qualquer mensagem dispara.') : words);
}

function publicCard(draft) {
  if (draft.trigger !== 'comment' || draft.media === 'live') return null;
  return h('div', { class: 'card stack' }, h('h2', {}, 'Resposta pública no comentário'),
    h('p', { class: 'muted small' }, 'Uma por linha. A cada comentário uma é sorteada, sem repetir a última. Deixe vazio para não responder em público.'),
    h('textarea', { rows: 5, value: draft.publicReplies.join('\n'), 'aria-label': 'Respostas públicas',
      oninput: event => change(value => { value.publicReplies = event.target.value.split('\n'); }) }),
    h('button', { class: 'btn link', type: 'button', onclick: () => change(value => { value.publicReplies = [...DEFAULT_PUBLIC]; }, true) }, 'Usar sugestões'));
}

// ---------- mensagens (blocos) ----------
const blockName = (draft, id) => {
  const index = draft.blocks.findIndex(block => block.id === id);
  return draft.blocks[index]?.type === 'handoff' ? `Etapa ${index + 1} · passar para mim` : `Mensagem ${index + 1}`;
};

function removeBlock(draft, id) {
  draft.blocks = draft.blocks.filter(block => block.id !== id);
  for (const block of draft.blocks) {
    if (block.next === id) block.next = null;
    for (const button of block.buttons) if (button.target === id) button.target = '';
  }
}

function moveUp(draft, index) {
  const [block] = draft.blocks.splice(index, 1);
  draft.blocks.splice(index - 1, 0, block);
}

function blocksCard(draft) {
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Mensagens no Direct'),
      h('button', { class: 'btn', type: 'button', disabled: draft.blocks.length >= 20, onclick: () => change(value => value.blocks.push(message('')), true) }, '+ Mensagem'),
      h('button', { class: 'btn', type: 'button', disabled: draft.blocks.length >= 20,
        onclick: () => change(value => value.blocks.push({ id: uid('b'), type: 'handoff', text: '', buttons: [], next: null, tag: '' }), true) }, '+ Passar para mim')),
    draft.trigger === 'comment' ? h('p', { class: 'muted small' }, 'Regra do Instagram: depois de um comentário só dá para mandar uma mensagem. '
      + 'Para continuar, a primeira precisa de um botão de resposta; os links vão na mensagem seguinte.') : null,
    draft.blocks.map((block, index) => blockCard(draft, block, index)));
}

function blockCard(draft, block, index) {
  const head = h('div', { class: 'block-head' }, h('h3', {}, `${blockName(draft, block.id)}${index === 0 ? ' · a primeira' : ''}`),
    index > 0 ? h('button', { class: 'btn link', type: 'button', onclick: () => change(value => moveUp(value, index), true) }, '↑ Subir') : null,
    draft.blocks.length > 1 ? h('button', { class: 'btn link danger', type: 'button', onclick: () => change(value => removeBlock(value, block.id), true) }, 'Remover') : null);
  if (block.type === 'handoff') {
    return h('div', { class: 'card stack block handoff' }, head,
      h('p', { class: 'muted small' }, 'A automação para aqui para essa pessoa e a conversa fica com você em Conversas.'));
  }
  return h('div', { class: 'card stack block' }, head, textField(block), buttonsField(draft, block), nextField(draft, block, index), tagField(block));
}

function textField(block) {
  const limit = block.buttons.length ? 640 : 1000;
  const counter = h('div', { class: 'counter' });
  const update = () => {
    const size = block.text.trim().length;
    counter.textContent = `${size} de ${limit} caracteres`;
    counter.classList.toggle('over', size > limit);
  };
  update();
  return h('label', { class: 'field' }, 'Texto',
    h('textarea', { rows: 4, value: block.text, maxlength: 1000, placeholder: 'Escreva a mensagem…',
      oninput: event => { change(() => { block.text = event.target.value; }); update(); } }),
    counter);
}

function addReplyButton(draft, block) {
  let target = draft.blocks.find(item => item.id !== block.id && !block.buttons.some(button => button.target === item.id));
  if (!target) {
    target = message('');
    draft.blocks.push(target);
  }
  block.buttons.push(replyButton('', target.id));
  block.next = null;
}

function buttonsField(draft, block) {
  const others = draft.blocks.filter(item => item.id !== block.id);
  const add = block.buttons.length < 3 ? h('div', { class: 'row' },
    h('button', { class: 'btn link', type: 'button', onclick: () => change(value => addReplyButton(value, block), true) }, '+ Botão de resposta'),
    h('button', { class: 'btn link', type: 'button', onclick: () => change(() => block.buttons.push(linkButton('')), true) }, '+ Botão de link')) : null;
  return h('div', { class: 'buttons' }, h('strong', {}, 'Botões (até 3)'),
    block.buttons.map(button => buttonRow(draft, block, button, others)), add);
}

function buttonRow(draft, block, button, others) {
  const title = h('input', { type: 'text', value: button.title, maxlength: 20, placeholder: 'Título (até 20)', 'aria-label': 'Título do botão',
    oninput: event => change(() => { button.title = event.target.value; }) });
  const target = button.type === 'link'
    ? h('input', { type: 'url', value: button.url || '', placeholder: 'https://…', 'aria-label': 'Endereço do link',
      oninput: event => change(() => { button.url = event.target.value.trim(); }) })
    : choice([['', 'Leva para…'], ...others.map(item => [item.id, blockName(draft, item.id)])], button.target,
      value => change(() => { button.target = value; }, true), { 'aria-label': 'Leva para' });
  return h('div', { class: 'button-row' }, title, h('span', { class: 'pill' }, button.type === 'link' ? 'Link' : 'Resposta'), target,
    h('button', { class: 'btn link danger', type: 'button', 'aria-label': 'Remover botão',
      onclick: () => change(() => { block.buttons = block.buttons.filter(item => item !== button); }, true) }, '×'));
}

function nextField(draft, block, index) {
  if (block.buttons.some(button => button.type === 'reply')) return h('p', { class: 'muted small' }, 'Segue pelo botão de resposta que a pessoa tocar.');
  if (draft.trigger === 'comment' && index === 0) return h('p', { class: 'muted small' }, 'Depois de um comentário, a conversa só continua por um botão de resposta.');
  const others = draft.blocks.filter(item => item.id !== block.id);
  return h('label', { class: 'field' }, 'Depois desta mensagem',
    choice([['', 'Termina aqui'], ...others.map(item => [item.id, `Manda em seguida: ${blockName(draft, item.id)}`])], block.next || '',
      value => change(() => { block.next = value || null; }, true)));
}

function tagField(block) {
  return h('label', { class: 'field' }, 'Etiqueta (opcional)', h('span', { class: 'hint' }, 'Marca quem recebeu esta mensagem. Aparece em Conversas.'),
    h('input', { type: 'text', value: block.tag || '', maxlength: 80, placeholder: 'ex.: pediu-link',
      oninput: event => change(() => { block.tag = event.target.value; }) }));
}

// ---------- prévia e situação ----------
function bubbleOut(block) {
  return h('div', { class: 'bubble out' }, block.text.trim() || '…',
    block.buttons.length ? h('div', { class: 'chips' }, block.buttons.map(button => h('span', {}, button.type === 'link'
      ? `↗ ${button.title || 'link'}` : button.title || 'botão'))) : null);
}

function previewCard(draft) {
  const keyword = String(draft.keywords || '').split(/[,;\n]/).map(word => word.trim()).find(Boolean);
  const sample = draft.trigger === 'story_mention' ? 'mencionou você' : draft.match !== 'any' && keyword ? keyword : 'Oi!';
  const items = [h('div', { class: 'bubble in' }, sample, h('small', {}, INCOMING[draft.trigger]))];
  const publicReply = draft.publicReplies.map(item => item.trim()).find(Boolean);
  if (draft.trigger === 'comment' && draft.media !== 'live' && publicReply) items.push(h('div', { class: 'bubble out' }, publicReply, h('small', {}, 'resposta pública')));
  const seen = new Set();
  let block = draft.blocks[0];
  while (block && !seen.has(block.id) && items.length < 8) {
    seen.add(block.id);
    if (block.type === 'handoff') { items.push(h('p', { class: 'muted small' }, 'A conversa passa para você.')); break; }
    items.push(bubbleOut(block));
    const reply = block.buttons.find(button => button.type === 'reply');
    if (reply) items.push(h('div', { class: 'bubble in' }, reply.title || 'botão', h('small', {}, 'tocou no botão')));
    const nextId = reply ? reply.target : block.next;
    block = draft.blocks.find(item => item.id === nextId);
  }
  return h('div', { class: 'card stack' }, h('h2', {}, 'Prévia'), h('div', { class: 'phone' }, items));
}

function statusCard(editing) {
  const [label, kind] = MODE[editing.mode] || ['desligada', ''];
  const ready = state.check?.ok === true;
  const pending = editing.mode !== 'off' && (state.dirty || editing.changed_since_publish);
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Situação'), h('span', { class: `pill ${kind}` }, label)),
    editing.mode === 'test' ? h('p', { class: 'small muted' }, `Responde só às ${editing.test_recipients.length} pessoa(s) do teste.`) : null,
    pending ? h('p', { class: 'small' }, h('span', { class: 'pill warn' }, 'mudanças não publicadas'), ' Elas só valem depois de ativar de novo.') : null,
    state.check ? h('div', { class: `check ${ready ? 'ok' : 'bad'}` }, ready ? 'Pronta para testar e ativar.' : state.check.error) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: save, disabled: !state.dirty }, state.dirty ? 'Salvar rascunho' : 'Salvo'),
      h('button', { class: 'btn', type: 'button', onclick: chooseTesters, disabled: !ready }, editing.mode === 'test' ? 'Mudar teste' : 'Testar'),
      h('button', { class: 'btn ok', type: 'button', onclick: () => publish('live'), disabled: !ready }, editing.mode === 'live' ? 'Publicar mudanças' : 'Ativar para todos'),
      editing.mode !== 'off' ? h('button', { class: 'btn', type: 'button', onclick: () => publish('off') }, 'Desligar') : null,
      editing.id && editing.mode === 'off' ? h('button', { class: 'btn danger', type: 'button', onclick: () => archive(!editing.archived_at) },
        editing.archived_at ? 'Restaurar' : 'Lixeira') : null),
    h('p', { class: 'small muted' }, 'Teste primeiro com você ou alguém da equipe: no teste, a automação só responde a essas pessoas.'));
}

async function save() {
  const editing = state.editing;
  const saved = await attempt(() => api('save', { id: editing.id || undefined, revision: editing.revision ?? undefined, draft: editing.draft }), 'Rascunho salvo.');
  if (!saved || saved === true) return null;
  state.editing = { ...saved, draft: normalizeDraft(saved.draft) };
  state.dirty = false;
  renderEditor();
  return saved;
}

async function publish(mode, recipients = []) {
  if (state.dirty && !(await save())) return;
  const messages = { off: 'Automação desligada.', test: 'Em teste: só responde às pessoas escolhidas.', live: 'Ativa para todo mundo!' };
  const result = await attempt(() => api('publish', { id: state.editing.id, mode, test_recipients: recipients }), messages[mode]);
  if (!result || result === true) return;
  state.editing = { ...result, draft: normalizeDraft(result.draft) };
  renderEditor();
}

async function archive(archived) {
  const result = await attempt(() => api('archive', { id: state.editing.id, archived }), archived ? 'Foi para a lixeira.' : 'Restaurada (desligada).');
  if (!result) return;
  state.editing = null;
  state.dirty = false;
  state.archived = false;
  loadAutomations();
}

async function chooseTesters() {
  const contacts = await attempt(() => api('contacts', { search: '' }));
  if (!Array.isArray(contacts)) return;
  const chosen = new Set(state.editing.test_recipients || []);
  const toggle = event => {
    if (event.target.checked && chosen.size >= 5) { event.target.checked = false; return toast('No teste, escolha até 5 pessoas.', true); }
    if (event.target.checked) chosen.add(event.target.value); else chosen.delete(event.target.value);
    return null;
  };
  const list = contacts.length ? h('div', { class: 'choices' }, contacts.map(contact => h('label', {},
    h('input', { type: 'checkbox', value: contact.igsid, checked: chosen.has(contact.igsid), onchange: toggle }),
    h('span', {}, contact.username ? `@${contact.username}` : contact.igsid, contact.name ? ` · ${contact.name}` : ''))))
    : h('p', { class: 'muted' }, 'Ninguém falou com o seu Instagram ainda. Mande uma mensagem de outro perfil para o seu Instagram e abra esta janela de novo.');
  const dialog = $('#dialog');
  const confirmButton = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    if (!chosen.size) return toast('Escolha ao menos uma pessoa.', true);
    dialog.close();
    return publish('test', [...chosen]);
  } }, 'Testar com essas pessoas');
  fill(dialog, h('h2', {}, 'Quem pode testar?'),
    h('p', { class: 'muted small' }, 'De 1 a 5 pessoas que já mandaram mensagem ou comentaram no seu Instagram.'), list,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancelar'), confirmButton));
  dialog.showModal();
}

// ---------- conversas ----------
const searchSoon = debounce(value => { state.search = value.trim().replace(/^@/, ''); loadInbox(); }, 350);

async function loadInbox() {
  const contacts = await attempt(() => api('contacts', { search: state.search }));
  if (Array.isArray(contacts)) state.contacts = contacts;
  renderInbox();
}

function renderInbox() {
  const root = $('#tab-conversas');
  if (!root.dataset.ready) {
    fill(root, 
      h('div', { class: 'bar' }, h('h1', { class: 'grow' }, 'Conversas'), h('button', { class: 'btn', type: 'button', onclick: loadInbox }, 'Atualizar')),
      h('div', { class: 'inbox' },
        h('div', { class: 'card stack' }, h('input', { type: 'search', placeholder: 'Buscar por @ ou nome', 'aria-label': 'Buscar contato',
          oninput: event => searchSoon(event.target.value) }), h('div', { class: 'contacts', id: 'contact-list' })),
        h('div', { class: 'card thread', id: 'thread' })));
    root.dataset.ready = '1';
  }
  renderContacts();
  renderThread();
}

function renderContacts() {
  const list = $('#contact-list');
  if (!state.contacts.length) {
    return fill(list, h('p', { class: 'muted small' }, 'Ninguém ainda. Quem comentar, mandar Direct ou responder um Story aparece aqui.'));
  }
  return fill(list, ...state.contacts.map(contact => h('button', { class: 'contact', type: 'button',
    'aria-current': String(state.contact?.id === contact.id), onclick: () => loadThread(contact.id, true) },
  h('strong', {}, contact.username ? `@${contact.username}` : contact.name || contact.igsid),
  h('span', { class: 'preview' }, contact.preview || ''),
  h('span', { class: 'small muted' }, fmt(contact.last_message_at), contact.automation_paused ? ' · automação pausada' : '',
    contact.tags?.length ? ` · ${contact.tags.join(', ')}` : ''))));
}

async function loadThread(id, focus = false) {
  const thread = await attempt(() => api('thread', { contact_id: id }));
  if (!thread || thread === true) return;
  state.contact = thread.contact;
  state.thread = thread;
  renderContacts();
  renderThread();
  if (focus && window.matchMedia('(max-width: 900px)').matches) $('#thread').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function messageBubble(item) {
  const out = item.direction === 'out';
  const who = out ? (item.automated ? 'automação' : 'você') : KIND_IN[item.kind] || 'mensagem';
  const status = out && STATUS[item.status] ? ` · ${STATUS[item.status]}${item.error ? `: ${item.error}` : ''}` : '';
  return h('div', { class: `bubble ${out ? 'out' : 'in'}` }, item.text || '—', h('small', {}, `${who} · ${fmt(item.created_at)}${status}`));
}

function replyBox(contact) {
  const open = contact.last_inbound_at && Date.now() - Date.parse(contact.last_inbound_at) < 24 * 3600 * 1000;
  if (!open) return h('p', { class: 'muted small' }, 'Já passaram 24 horas da última mensagem da pessoa: o Instagram só deixa responder quando ela escrever de novo.');
  const area = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'Responder no Direct…', 'aria-label': 'Resposta', id: 'reply-text' });
  const send = async () => {
    const text = area.value.trim();
    if (!text) return;
    const ok = await attempt(() => api('reply', { contact_id: contact.id, text, request_id: crypto.randomUUID() }), 'Resposta enviada.');
    if (ok) await Promise.all([loadThread(contact.id), reloadContacts()]);
  };
  return h('div', { class: 'reply' }, area, h('div', { class: 'row' },
    h('span', { class: 'small muted grow' }, 'Ao responder, a automação pausa para esta pessoa.'),
    h('button', { class: 'btn primary', type: 'button', onclick: send }, 'Enviar')));
}

function renderThread() {
  const box = $('#thread');
  if (!state.thread) return fill(box, h('p', { class: 'muted' }, 'Escolha uma conversa.'));
  const contact = state.thread.contact;
  const messages = h('div', { class: 'messages' }, state.thread.messages.map(messageBubble));
  fill(box, 
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, contact.username ? `@${contact.username}` : contact.igsid,
      contact.name ? h('span', { class: 'muted small' }, ` · ${contact.name}`) : null),
    h('button', { class: 'btn', type: 'button', onclick: () => togglePause(contact) }, contact.automation_paused ? 'Retomar automação' : 'Pausar automação'),
    h('button', { class: 'btn danger', type: 'button', onclick: () => forget(contact) }, 'Apagar dados')),
    messages, replyBox(contact));
  messages.scrollTop = messages.scrollHeight;
  return null;
}

async function forget(contact) {
  const who = contact.username ? `@${contact.username}` : contact.igsid;
  if (!confirm(`Apagar para sempre a conversa e os dados de ${who}? Use quando a pessoa pedir a exclusão.`)) return;
  const ok = await attempt(() => api('forget_contact', { contact_id: contact.id, confirm: true }), `Dados de ${who} apagados.`);
  if (!ok) return;
  state.contact = null;
  state.thread = null;
  renderThread();
  await reloadContacts();
}

async function togglePause(contact) {
  const paused = !contact.automation_paused;
  const ok = await attempt(() => api('pause_contact', { contact_id: contact.id, paused }), paused ? 'Automação pausada para esta pessoa.' : 'Automação retomada.');
  if (ok) await Promise.all([loadThread(contact.id), reloadContacts()]);
}

async function reloadContacts() {
  const contacts = await api('contacts', { search: state.search }).catch(() => null);
  if (!Array.isArray(contacts)) return;
  state.contacts = contacts;
  renderContacts();
}

// Atualiza a lista sozinha, sem apagar uma resposta que você esteja escrevendo.
async function refreshInbox() {
  if (document.visibilityState !== 'visible' || $('#tab-conversas').hidden) return;
  await reloadContacts();
  const typing = $('#reply-text');
  if (state.contact && (!typing || (!typing.value && document.activeElement !== typing))) loadThread(state.contact.id);
}

// ---------- conexão ----------
async function loadConnection() {
  const status = await attempt(() => api('status'));
  if (status && status !== true) {
    state.status = status;
    if (!status.accounts.some(item => item.account === state.account) && status.accounts[0]) state.account = status.accounts[0].account;
  }
  renderWho();
  renderConnection();
}

async function connect() {
  const link = await attempt(() => api('connect', { expected_username: null }));
  if (!link || link === true) return;
  window.open(link.url, '_blank', 'noopener');
  toast('Autorize na janela da Meta. Esta tela atualiza sozinha.');
  for (let round = 0; round < 40; round++) {
    await new Promise(done => setTimeout(done, 3000));
    const status = await api('status').catch(() => null);
    const account = status?.accounts.find(item => item.account === state.account);
    if (account?.status === 'connected' && Date.now() - Date.parse(account.connected_at) < 5 * 60 * 1000) {
      state.status = status;
      toast(`Conectado: @${account.username}`);
      return loadConnection();
    }
  }
  return loadConnection();
}

async function check() {
  const result = await attempt(() => api('check'));
  if (!result || result === true) return;
  toast(result.subscribed ? `A Meta confirmou o @${result.username} e os eventos estão inscritos.`
    : 'A Meta confirmou o acesso, mas a Página não aceitou a inscrição dos eventos. Confira os Webhooks e se o app está no modo Ativo.', !result.subscribed);
  loadConnection();
}

async function tick() {
  const result = await attempt(() => api('tick'));
  if (!result || result === true) return;
  toast(`Comentários novos: ${result.comments}. Eventos: ${result.events}. Envios: ${result.sent}.`);
}

function accountCard(account) {
  if (account?.status !== 'connected') {
    return h('div', { class: 'card stack' }, h('h2', {}, 'Instagram'),
      h('p', {}, account?.status === 'expired' ? 'A Meta pediu uma nova autorização.' : 'Nenhum Instagram conectado.'),
      account?.pending ? h('p', { class: 'muted small' }, 'A Meta aprovou, mas falta escolher o Instagram. Rode: npm run conectar -- --retomar --instagram @seuperfil') : null,
      h('p', { class: 'muted small' }, 'Use o Facebook que administra a Página ligada ao Instagram profissional.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: connect }, 'Conectar Instagram')));
  }
  return h('div', { class: 'card stack' }, h('h2', {}, `@${account.username}`),
    h('dl', { class: 'kv' }, h('dt', {}, 'Conectado em'), h('dd', {}, fmt(account.connected_at)),
      h('dt', {}, 'Eventos'), h('dd', {}, account.subscribed ? h('span', { class: 'pill live' }, 'inscritos') : h('span', { class: 'pill bad' }, 'não inscritos')),
      account.last_error ? [h('dt', {}, 'Último aviso'), h('dd', {}, account.last_error)] : null),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: check }, 'Conferir com a Meta'),
      h('button', { class: 'btn', type: 'button', onclick: connect }, 'Reconectar')));
}

function systemCard(status) {
  const counts = status.automations;
  return h('div', { class: 'card stack' }, h('h2', {}, 'Funcionamento'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'App da Meta'), h('dd', {}, status.meta_configured ? 'configurado' : 'falta configurar (npm run configurar)'),
      h('dt', {}, 'Agendador'), h('dd', {}, status.scheduler_ready ? 'ativo, a cada minuto' : 'desligado (npm run configurar)'),
      h('dt', {}, 'Automações'), h('dd', {}, `${counts.live} ativa(s), ${counts.test} em teste, ${counts.off} desligada(s)`),
      h('dt', {}, 'Mensagens na fila'), h('dd', {}, status.queue),
      h('dt', {}, 'Último evento'), h('dd', {}, status.last_event_at ? fmt(status.last_event_at) : 'nenhum ainda')),
    h('p', { class: 'muted small' }, 'Comentários são buscados a cada minuto. Direct, Stories e botões chegam na hora pelo webhook.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: tick }, 'Processar agora')));
}

function renderConnection() {
  const root = $('#tab-conexao');
  if (!state.status) return fill(root, h('p', { class: 'muted' }, 'Não consegui ler a situação. Confira se a função está no ar (npm run status).'));
  const account = state.status.accounts.find(item => item.account === state.account);
  return fill(root, 
    h('div', { class: 'bar' }, h('h1', { class: 'grow' }, 'Conexão'), h('button', { class: 'btn', type: 'button', onclick: loadConnection }, 'Atualizar')),
    h('div', { class: 'grid' }, accountCard(account), systemCard(state.status)));
}

// ---------- início ----------
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));
window.addEventListener('beforeunload', event => {
  if (state.editing && state.dirty) { event.preventDefault(); event.returnValue = ''; }
});
await loadConnection();
showTab('automacoes');
setInterval(refreshInbox, 20000);
