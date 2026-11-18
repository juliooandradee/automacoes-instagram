// Servidor local do quadro: entrega a tela (pasta painel/) e repassa os comandos à função com a chave secreta.
// Só escuta em 127.0.0.1 e só aceita pedidos vindos da própria tela. A chave nunca vai para o navegador.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT } from './env.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 200000;
const PANEL_DIR = path.join(ROOT, 'painel');

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new Error('Pedido grande demais.'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

// Protege contra outro site aberto no navegador tentando usar o quadro (DNS rebinding e CSRF).
export function trustedRequest(request, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.host || '')) return false;
  if (request.method !== 'POST') return true;
  const origin = request.headers.origin || '';
  return hosts.some(host => origin === `http://${host}`);
}

async function proxy(request, response, api) {
  let body;
  try {
    body = JSON.parse((await readBody(request)) || '{}');
  } catch {
    return send(response, 400, { error: 'Pedido inválido.' });
  }
  if (!/^[a-z_]{2,30}$/.test(body?.action || '')) return send(response, 400, { error: 'Ação inválida.' });
  try {
    const { status, data } = await api.call(body.action, body);
    return send(response, status, data ?? null);
  } catch (error) {
    return send(response, 502, { error: error.message });
  }
}

function serveFile(request, response) {
  const name = new URL(request.url, 'http://local').pathname.replace(/^\/+/, '') || 'index.html';
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) return send(response, 404, 'Não encontrado.', 'text/plain; charset=utf-8');
  const file = path.join(PANEL_DIR, name);
  if (!fs.existsSync(file)) return send(response, 404, 'Não encontrado.', 'text/plain; charset=utf-8');
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
  fs.createReadStream(file).pipe(response);
  return null;
}

export function createPanelServer({ api, port }) {
  return http.createServer((request, response) => {
    if (!trustedRequest(request, port)) return send(response, 403, { error: 'Acesso recusado.' });
    if (request.method === 'POST' && request.url === '/api') return proxy(request, response, api);
    if (request.method === 'GET') return serveFile(request, response);
    return send(response, 405, { error: 'Método não permitido.' });
  });
}

// Sobe na primeira porta livre a partir da pedida.
export async function startPanel({ api, port = 4321 }) {
  for (let candidate = port; candidate < port + 10; candidate++) {
    const server = createPanelServer({ api, port: candidate });
    const ok = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, url: `http://127.0.0.1:${candidate}/` };
  }
  throw new Error(`Não achei porta livre entre ${port} e ${port + 9}. Rode com --porta outra.`);
}
