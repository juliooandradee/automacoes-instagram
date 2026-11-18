// Ponta a ponta: a função de verdade contra o banco de verdade (Postgres local com a migração), só a Meta é simulada.
// Precisa do Postgres 15+ (macOS: brew install postgresql@16). Sem ele, o teste é pulado.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { makeHandler } from '../supabase/functions/automacoes/handler.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT = 'https://projeto-teste.supabase.co';
const KEY = 'sb_secret_chave_de_teste_1234567890';
const IG = '17841400000000001';
const PAGE = '500100';
const POST = '18000000000000001';
const APP_SECRET = 'ab'.repeat(16);
const PORT = 55495;

function pgBin() {
  const brew = '/opt/homebrew/opt/postgresql@16/bin';
  if (fs.existsSync(path.join(brew, 'initdb'))) return brew;
  const found = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  return found.status === 0 ? path.dirname(found.stdout.trim()) : null;
}

let pg = null;
function startPostgres() {
  const bin = pgBin();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automacoes-it-'));
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  spawnSync(path.join(bin, 'initdb'), ['-D', `${dir}/data`, '-A', 'trust', '-U', 'postgres'], { env, stdio: 'ignore' });
  const started = spawnSync(path.join(bin, 'pg_ctl'), ['-D', `${dir}/data`, '-o', `-k '' -c listen_addresses=127.0.0.1 -p ${PORT}`, '-l', `${dir}/log`, '-w', 'start'], { env, stdio: 'ignore' });
  if (started.status !== 0) return null;
  const psql = sql => spawnSync(path.join(bin, 'psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-X', '-tA'],
    { input: sql, encoding: 'utf8', env: { ...env, PGOPTIONS: '-c client_min_messages=warning' } });
  const stop = () => {
    spawnSync(path.join(bin, 'pg_ctl'), ['-D', `${dir}/data`, 'stop', '-m', 'immediate'], { env, stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { psql, stop };
}

const sql = text => {
  const result = pg.psql(text);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

function rpc(name, args) {
  const tag = '$rpc$';
  const result = pg.psql(`select test_rpc.call(${tag}${name}${tag}, ${tag}${JSON.stringify(args ?? {})}${tag}::jsonb);`);
  if (result.status !== 0) return { status: 400, body: { message: (result.stderr.match(/ERROR:\s+(.*)/)?.[1] || result.stderr).trim() } };
  const out = result.stdout.trim();
  return { status: 200, body: out ? JSON.parse(out) : null };
}

// Meta de mentira, com memória do que foi enviado.
const meta = { comments: {}, sent: [], replies: [], counter: 0 };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function graph(url, method, body) {
  const route = url.pathname.replace(/^\/v\d+\.\d+/, '');
  const query = Object.fromEntries(url.searchParams);
  if (route === '/oauth/access_token') return reply({ access_token: query.code ? 'chave-de-usuario-curta-123456' : 'chave-de-usuario-longa-123456' });
  if (route === '/debug_token') return reply({ data: { is_valid: true, app_id: '1234567890', scopes: ['instagram_basic', 'instagram_manage_messages',
    'instagram_manage_comments', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_messaging', 'business_management'] } });
  if (route === '/me/accounts') return reply({ data: [{ id: PAGE, name: 'Consultório', access_token: 'CHAVE-DA-PAGINA-123456789', instagram_business_account: { id: IG, username: 'consultorio.exemplo' } }] });
  if (route === `/${PAGE}/subscribed_apps`) return reply({ success: true });
  if (route === `/${PAGE}/messages`) {
    meta.sent.push(body);
    const recipient = body.recipient.id || meta.commenters[body.recipient.comment_id];
    return reply({ recipient_id: recipient, message_id: `mid.${++meta.counter}` });
  }
  if (route.endsWith('/replies')) { meta.replies.push({ comment: route.split('/')[1], text: body.message }); return reply({ id: `179${++meta.counter}0000000` }); }
  if (route.endsWith('/comments')) return reply({ data: meta.comments[route.split('/')[1]] || [] });
  if (route === `/${IG}/media` || route === `/${IG}/live_media`) return reply({ data: [] });
  const id = route.slice(1);
  if (meta.commenters?.[id]) return reply({ id, timestamp: new Date().toISOString(), media: { id: POST } });
  return reply({ id, name: 'Pessoa do Direct', username: 'pessoa.dm' });
}

async function fetcher(input, options = {}) {
  const url = new URL(String(input));
  const method = options.method || 'GET';
  let body = null;
  if (options.body instanceof URLSearchParams) body = Object.fromEntries(options.body);
  else if (typeof options.body === 'string') body = JSON.parse(options.body);
  if (url.hostname === 'graph.facebook.com') return graph(url, method, body);
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const result = rpc(url.pathname.slice('/rest/v1/rpc/'.length), body);
    return reply(result.body, result.status);
  }
  return reply({ error: 'inesperado' }, 500);
}

const handler = makeHandler({ env: { SUPABASE_URL: PROJECT, SUPABASE_SECRET_KEYS: JSON.stringify({ default: KEY }) }, fetcher, random: () => 0 });
const command = async body => {
  const response = await handler(new Request(`${PROJECT}/functions/v1/automacoes`, { method: 'POST', headers: { apikey: KEY }, body: JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
};
const cron = async () => handler(new Request(`${PROJECT}/functions/v1/automacoes`, { method: 'POST',
  headers: { 'x-automacoes-cron': sql("select decrypted_secret from vault.decrypted_secrets where name = 'instagram_automations_cron_secret'") } }));
async function webhook(messaging) {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging }] });
  const signature = crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  return handler(new Request(`${PROJECT}/functions/v1/automacoes`, { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${signature}` }, body }));
}
const dm = (from, text, extra = {}) => ({ sender: { id: from }, recipient: { id: IG }, timestamp: Date.now(),
  message: { mid: `in.${crypto.randomUUID()}`, text, ...extra } });

async function automation(draft, mode = 'live', testRecipients = []) {
  const saved = await command({ action: 'save', draft });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const published = await command({ action: 'publish', id: saved.data.id, mode, test_recipients: testRecipients });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  return published.data;
}

before(() => {
  pg = startPostgres();
  if (!pg) return;
  for (const file of ['tests/sql/stubs.sql', 'supabase/migrations/20261118200000_instagram_automations.sql', 'tests/sql/rpc-shim.sql']) {
    sql(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
});
after(() => pg?.stop());

test('configura, conecta pela Página e inscreve os eventos', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  const configured = await command({ action: 'configure', app_id: '1234567890', app_secret: APP_SECRET, config_id: '987654321', graph_version: 'v26.0' });
  assert.equal(configured.data.redirect_uri, `${PROJECT}/functions/v1/automacoes`);
  const verify = await handler(new Request(`${PROJECT}/functions/v1/automacoes?hub.mode=subscribe&hub.verify_token=${configured.data.verify_token}&hub.challenge=4242`));
  assert.equal(await verify.text(), '4242');
  const link = await command({ action: 'connect', expected_username: '@consultorio.exemplo' });
  const state = new URL(link.data.url).searchParams.get('state');
  const back = await handler(new Request(`${PROJECT}/functions/v1/automacoes?code=codigo&state=${state}`));
  assert.match(await back.text(), /@consultorio\.exemplo está conectado/);
  const status = await command({ action: 'status' });
  assert.equal(status.data.accounts[0].status, 'connected');
  assert.equal(status.data.accounts[0].subscribed, true);
});

test('comentário no post: resposta privada com botão, resposta pública, link rastreado e clique', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  await automation({ name: 'Comente GUIA', trigger: 'comment', media: 'specific', mediaId: POST, match: 'contains', keywords: 'guia',
    publicReplies: ['Te chamei no Direct!', 'Olha o Direct!'],
    blocks: [
      { id: 'b1', text: 'Quer receber o guia?', buttons: [{ id: 'sim', type: 'reply', title: 'LIBERAR', target: 'b2' }] },
      { id: 'b2', text: 'Aqui está o seu guia:', buttons: [{ id: 'abrir', type: 'link', title: 'Abrir o guia', url: 'https://consultorio.test/guia' }] },
    ] });
  meta.commenters = { '17900000000000111': '700100' };
  meta.comments[POST] = [{ id: '17900000000000111', text: 'Quero o GUIA!', timestamp: new Date(Date.now() + 2000).toISOString(),
    from: { id: '700100', username: 'pessoa.teste' } }];
  const tick = await (await cron()).json();
  assert.equal(tick.comments, 1);
  const first = meta.sent.at(-1);
  assert.equal(first.recipient.comment_id, '17900000000000111');
  assert.equal(first.message.quick_replies[0].title, 'LIBERAR');
  assert.deepEqual(meta.replies.map(item => item.text), ['Te chamei no Direct!']);
  assert.equal(meta.replies[0].comment, '17900000000000111');
  // A pessoa toca em LIBERAR: a resposta rápida volta pelo webhook assinado.
  const choice = dm('700100', 'LIBERAR', { quick_reply: { payload: first.message.quick_replies[0].payload } });
  assert.equal((await webhook([choice])).status, 200);
  const second = meta.sent.at(-1);
  assert.equal(second.recipient.id, '700100');
  const button = second.message.attachment.payload.buttons[0];
  assert.equal(button.type, 'web_url');
  assert.match(button.url, /^https:\/\/projeto-teste\.supabase\.co\/functions\/v1\/automacoes\/l\/[\w-]{20,}$/);
  const click = await handler(new Request(button.url));
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://consultorio.test/guia');
  // Comentário repetido não gera nova execução; o mesmo botão de novo não reenvia o material.
  await cron();
  assert.equal((await webhook([choice])).status, 200);
  assert.equal(meta.sent.filter(item => item.recipient.id === '700100' || item.recipient.comment_id).length, 2);
  const list = await command({ action: 'automations' });
  const metrics = list.data.find(item => item.published.name === 'Comente GUIA').metrics;
  assert.deepEqual([metrics.runs, metrics.contacts, metrics.clicked], [1, 1, 1]);
});

test('Direct com palavra no modo teste: só a pessoa de teste recebe', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  await automation({ name: 'Agenda', trigger: 'direct', media: 'all', match: 'contains', keywords: 'agenda, horario',
    blocks: [{ id: 'b1', text: 'Os horários estão no link:', buttons: [{ id: 'ver', type: 'link', title: 'Ver horários', url: 'https://consultorio.test/agenda' }] }] },
  'test', ['700200']);
  const before = meta.sent.length;
  await webhook([dm('700300', 'qual a agenda?')]);
  assert.equal(meta.sent.length, before, 'quem não está no teste não recebe');
  await webhook([dm('700200', 'Qual o HORÁRIO?')]);
  assert.equal(meta.sent.length, before + 1);
  assert.equal(meta.sent.at(-1).recipient.id, '700200');
  const contacts = await command({ action: 'contacts' });
  assert.ok(contacts.data.some(item => item.igsid === '700300' && item.username === 'pessoa.dm'), 'busca o @ de quem escreveu');
});

test('resposta a Story e passagem para atendimento humano', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  await automation({ name: 'Story', trigger: 'story_reply', media: 'all', match: 'any', keywords: '',
    blocks: [{ id: 'b1', text: 'Obrigado por responder o Story! Já te respondo.', next: 'b2' }, { id: 'b2', type: 'handoff' }] });
  const before = meta.sent.length;
  await webhook([dm('700600', 'Amei!', { reply_to: { story: { id: '18000000000000777', url: 'https://cdn.exemplo/x' } } })]);
  assert.equal(meta.sent.length, before + 1);
  assert.match(meta.sent.at(-1).message.text, /Obrigado por responder o Story/);
  const contact = (await command({ action: 'contacts', search: '' })).data.find(item => item.igsid === '700600');
  assert.equal(contact.automation_paused, true, 'atendimento humano pausa a automação da pessoa');
});

test('resposta pelo celular pausa a automação; resposta pelo quadro respeita a janela', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  await webhook([dm('700500', 'oi, tudo bem?')]);
  sql("update instagram_automations.messages set created_at = now() - interval '10 minutes'");
  const echo = { sender: { id: IG }, recipient: { id: '700500' }, timestamp: Date.now(), message: { mid: 'eco.manual.1', text: 'Oi! Aqui é a equipe.', is_echo: true } };
  await webhook([echo]);
  const contact = (await command({ action: 'contacts' })).data.find(item => item.igsid === '700500');
  assert.equal(contact.automation_paused, true);
  const answered = await command({ action: 'reply', contact_id: contact.id, text: 'Pode me mandar o seu e-mail?', request_id: crypto.randomUUID() });
  assert.equal(answered.status, 200);
  assert.equal(meta.sent.at(-1).message.text, 'Pode me mandar o seu e-mail?');
  sql(`update instagram_automations.contacts set last_inbound_at = now() - interval '25 hours' where igsid = '700500'`);
  const closed = await command({ action: 'reply', contact_id: contact.id, text: 'Oi de novo', request_id: crypto.randomUUID() });
  assert.equal(closed.status, 409);
  assert.match(closed.data.error, /janela de 24 horas/);
});

test('webhook sem assinatura certa é recusado e não grava nada', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  const before = sql('select count(*) from instagram_automations.events');
  const response = await handler(new Request(`${PROJECT}/functions/v1/automacoes`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00' },
    body: JSON.stringify({ object: 'instagram', entry: [{ id: IG, messaging: [dm('700900', 'agenda')] }] }) }));
  assert.equal(response.status, 401);
  assert.equal(sql('select count(*) from instagram_automations.events'), before);
});

test('página de privacidade e exclusão dos dados de uma pessoa', { skip: !pgBin() && 'sem Postgres local' }, async () => {
  const page = await handler(new Request(`${PROJECT}/functions/v1/automacoes/privacidade`));
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.match(body, /@consultorio\.exemplo/);
  assert.match(body, /exclusão/);
  await webhook([dm('700800', 'quero apagar meus dados')]);
  const contact = (await command({ action: 'contacts' })).data.find(item => item.igsid === '700800');
  const refused = await command({ action: 'forget_contact', contact_id: contact.id });
  assert.equal(refused.status, 400, 'pede confirmação');
  const forgotten = await command({ action: 'forget_contact', contact_id: contact.id, confirm: true });
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.data.igsid, '700800');
  assert.ok(!(await command({ action: 'contacts' })).data.some(item => item.igsid === '700800'));
  assert.equal(sql(`select count(*) from instagram_automations.events where payload->>'scopedId' = '700800'`), '0');
});
