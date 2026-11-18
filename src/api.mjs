// Conversa da linha de comando e do quadro com a função "automacoes" do seu Supabase, usando a chave secreta.
import { keyHeaders } from '../supabase/functions/_shared/rest.mjs';

export function createApi({ url, key, fetcher = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(base)) throw new Error('SUPABASE_URL inválido no .env (exemplo: https://abcdefgh.supabase.co).');
  if (!key || key.length < 20) throw new Error('Falta a SUPABASE_SECRET_KEY no .env (Supabase → Settings → API Keys → secret).');
  // A chave antiga (service_role, que começa com eyJ) para de funcionar no fim de 2026 e a função não a reconhece.
  if (!key.startsWith('sb_secret_')) {
    throw new Error('Use a chave secreta nova, que começa com sb_secret_ (Supabase → Settings → API Keys → Secret keys).');
  }
  return {
    async call(action, body = {}) {
      const response = await fetcher(`${base}/functions/v1/automacoes`, {
        method: 'POST', headers: { ...keyHeaders(key), 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 404 && !data?.error) {
        throw new Error('A função automacoes não está no ar. Publique com: npm run supabase:instalar');
      }
      return { status: response.status, data };
    },
  };
}

export function answer({ status, data }, fallback = 'A função automacoes recusou o pedido.') {
  if (status >= 400 || data?.error) throw new Error(data?.error || `${fallback} (código ${status})`);
  return data;
}
