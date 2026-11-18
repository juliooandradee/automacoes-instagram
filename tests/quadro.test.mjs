import assert from 'node:assert/strict';
import test from 'node:test';
import { startPanel } from '../src/quadro.mjs';

test('o quadro só atende a própria tela e repassa os comandos com a chave do servidor', async () => {
  const calls = [];
  const api = { call: async (action, body) => { calls.push({ action, body }); return { status: 200, data: { ok: true, action } }; } };
  const { server, url } = await startPanel({ api, port: 47321 });
  const origin = url.replace(/\/$/, '');
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /Automações do Instagram/);
    const post = body => fetch(`${origin}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body });
    const answered = await post(JSON.stringify({ action: 'status' }));
    assert.deepEqual(await answered.json(), { ok: true, action: 'status' });
    assert.equal(calls.length, 1);
    const foreign = await fetch(`${origin}/api`, { method: 'POST', headers: { Origin: 'https://outro-site.example' }, body: '{"action":"status"}' });
    assert.equal(foreign.status, 403);
    assert.equal((await post('{"action":"../x"}')).status, 400);
    assert.equal((await post('não é json')).status, 400);
    assert.equal((await fetch(`${origin}/..%2fsrc%2fenv.mjs`)).status, 404);
    assert.equal((await fetch(`${origin}/env.mjs`)).status, 404);
    assert.equal(calls.length, 1, 'nada além do pedido válido chegou à função');
  } finally {
    await new Promise(done => server.close(done));
  }
});
