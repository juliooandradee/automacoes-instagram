// Acesso ao banco do próprio projeto com a chave secreta (service_role).
// Funciona com as chaves novas (sb_secret_...) e com a chave service_role antiga (JWT).

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// As chaves novas vão só no cabeçalho apikey; a antiga, que é um JWT, também vai no Authorization.
export function keyHeaders(key) {
  return key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

// Todas as chaves secretas que o Supabase entrega à função: as novas (SUPABASE_SECRET_KEYS) e a antiga.
export function serverKeys(env) {
  const keys = [];
  try {
    keys.push(...Object.values(JSON.parse(env.SUPABASE_SECRET_KEYS || '{}')));
  } catch {
    // Projeto sem as chaves novas.
  }
  if (env.SUPABASE_SERVICE_ROLE_KEY) keys.push(env.SUPABASE_SERVICE_ROLE_KEY);
  return keys.filter(key => typeof key === 'string' && key.length >= 20);
}

// Comparação em tempo constante, para não vazar a chave pelo tempo de resposta.
export function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function presentedKey(request) {
  const apikey = request.headers.get('apikey');
  if (apikey) return apikey;
  const authorization = request.headers.get('authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export class RestError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createRest({ url, key, fetcher = fetch }) {
  const headers = { ...keyHeaders(key), 'Content-Type': 'application/json' };
  return {
    async rpc(name, args = {}) {
      const response = await fetcher(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new RestError(data?.message || data?.error || `Falha no Supabase (${response.status}).`,
          { status: response.status, code: data?.code || null });
      }
      return data;
    },
  };
}

// SHA-256 em hexadecimal (Web Crypto: funciona no Deno e no Node).
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret, bytes) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 24) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
