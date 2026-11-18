import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.mjs';

const ENV = { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_chave_de_teste_1234567890' };
const AUTOMATION = { id: '3344da1a-0000-4000-8000-000000000001', mode: 'off', revision: 1, test_recipients: [], metrics: {},
  draft: { name: 'Direct · GUIA', trigger: 'direct', match: 'contains', keywords: 'guia', blocks: [] } };
const CONTACTS = [{ id: '9a9a9a9a-0000-4000-8000-000000000002', igsid: '900000000000001', username: 'ana.souza', name: 'Ana' }];

// Função de mentira: guarda cada chamada e responde como a função do Supabase.
function fakeApi(overrides = {}) {
  const calls = [];
  const answers = {
    status: { meta_configured: true, scheduler_ready: true, accounts: [{ account: 'principal', status: 'connected', username: 'consultorio.exemplo',
      connected_at: '2026-11-18T10:00:00Z', subscribed: true }], automations: { live: 1, test: 0, off: 2 }, queue: 0, last_event_at: null },
    automations: [AUTOMATION], automation: AUTOMATION, contacts: CONTACTS,
    save: { ...AUTOMATION }, validate: { ok: true },
    publish: { ...AUTOMATION, mode: 'test' }, disconnect: { account: 'principal', username: 'consultorio.exemplo' },
    configure: { ok: true, redirect_uri: 'https://x/functions/v1/automacoes', webhook_url: 'https://x/functions/v1/automacoes',
      privacy_url: 'https://x/functions/v1/automacoes/privacidade', verify_token: 'token-de-verificacao', meta_configured: true },
    ...overrides,
  };
  return { calls, call: async (action, body = {}) => { calls.push({ action, ...body });
    const data = typeof answers[action] === 'function' ? answers[action](body) : answers[action];
    return data instanceof Error ? { status: 422, data: { error: data.message } } : { status: 200, data }; } };
}

async function run(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { env: ENV, log: line => out.push(line), fail: line => err.push(line), ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('ajuda e comando desconhecido', async () => {
  assert.match((await run(['ajuda'])).out, /npm run <comando>/);
  const unknown = await run(['voar']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Comando desconhecido: voar/);
  const option = await run(['automacoes', '--xyz'], { api: fakeApi() });
  assert.match(option.err, /^Erro: Opção desconhecida: --xyz\. Veja: npm run ajuda$/);
});

test('status descreve conexão, agendador e automações', async () => {
  const { out, code } = await run(['status'], { api: fakeApi() });
  assert.equal(code, 0);
  assert.match(out, /@consultorio\.exemplo, conectado em 18\/11\/2026/);
  assert.match(out, /1 ativa\(s\), 0 em teste, 2 desligada\(s\)/);
});

test('configurar mostra o que colar na Meta e tira a chave secreta do .env', async () => {
  const written = [];
  const api = fakeApi();
  const { out } = await run(['configurar'], { api, env: { ...ENV, META_APP_ID: '123', META_APP_SECRET: 'segredo', META_CONFIG_ID: '456' },
    writeEnv: (name, value) => written.push([name, value]) });
  assert.equal(api.calls[0].app_secret, 'segredo');
  assert.match(out, /Token de verificação:\n {4}token-de-verificacao/);
  assert.match(out, /\/privacidade/);
  assert.deepEqual(written, [['META_APP_SECRET', '']]);
});

test('salvar lê o arquivo, cria a automação e diz se já pode ativar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automacoes-cli-'));
  const file = path.join(dir, 'guia.json');
  fs.writeFileSync(file, JSON.stringify(AUTOMATION.draft));
  const api = fakeApi({ validate: new Error('Troque o link de exemplo (exemplo.com) pelo seu link de verdade.') });
  const { out } = await run(['salvar', file], { api });
  assert.equal(api.calls[0].action, 'save');
  assert.equal(api.calls[0].draft.name, 'Direct · GUIA');
  assert.match(out, /Criada: 3344da1a/);
  assert.match(out, /ainda não dá para ativar: Troque o link de exemplo/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('testar troca o @ pelo id da pessoa e aceita o id curto da automação', async () => {
  const api = fakeApi();
  const { out, code } = await run(['testar', '3344da1a', '--pessoas', '@ana.souza,900000000000009'], { api });
  assert.equal(code, 0, out);
  const publish = api.calls.find(call => call.action === 'publish');
  assert.deepEqual(publish.test_recipients, ['900000000000001', '900000000000009']);
  assert.equal(publish.id, AUTOMATION.id);
  assert.match(out, /em teste: só responde a 2 pessoa/);
});

test('ações que não têm volta pedem confirmação', async () => {
  const api = fakeApi();
  assert.match((await run(['desconectar'], { api })).err, /--sim/);
  assert.match((await run(['apagar-contato', '@ana.souza'], { api })).err, /apagar-contato -- @ana\.souza --sim/);
  assert.ok(!api.calls.some(call => ['disconnect', 'forget_contact'].includes(call.action)));
  assert.match((await run(['desconectar', '--sim'], { api })).out, /Desconectado o @consultorio\.exemplo/);
});

test('sem a chave do Supabase, avisa o que preencher', async () => {
  const { err } = await run(['status'], { env: { SUPABASE_URL: 'https://SEU-PROJETO.supabase.co', SUPABASE_SECRET_KEY: 'COLE-AQUI' } });
  assert.match(err, /Falta preencher no arquivo \.env: SUPABASE_URL, SUPABASE_SECRET_KEY/);
});
