// Busca de comentários a cada minuto. Funciona com o acesso padrão da Meta, sem análise do app:
// o webhook de comentários só é entregue com acesso avançado. Se ele chegar, as chaves iguais evitam repetição.
import { GraphClient } from './graph.mjs';
import { polledCommentEvent } from './events.mjs';

const MAX_PAGES = 4;

export function makePoller({ rest, version, fetcher = fetch }) {
  async function newComments(client, mediaId, since) {
    const found = [];
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.comments(mediaId, after);
      const fresh = result.items.filter(item => Date.parse(item.timestamp) > since);
      found.push(...fresh);
      // A Meta devolve os mais novos primeiro: página sem nada novo encerra a busca.
      if (!fresh.length || !result.after) break;
      after = result.after;
    }
    return found;
  }

  async function pollMedia(client, target, media) {
    const cursor = !media.live && target.newest_comment_at ? Date.parse(target.newest_comment_at) : 0;
    const since = Math.max(Date.parse(target.activated_at), cursor);
    const comments = await newComments(client, media.id, since);
    const events = comments.map(item => polledCommentEvent(target.ig_user_id, media.id, item, media.live)).filter(Boolean);
    if (events.length) await rest.rpc('instagram_automations_ingest', { p_ig_user_id: target.ig_user_id, p_events: events });
    const newest = comments.reduce((max, item) => Math.max(max, Date.parse(item.timestamp)), 0);
    if (newest) await rest.rpc('instagram_automations_save_cursor', { p_account: target.account_id, p_media_id: media.id, p_newest: new Date(newest).toISOString() });
    return events.length;
  }

  // "Próxima publicação": a primeira publicação do feed depois da ativação vira a publicação da automação.
  async function bindNext(client, target) {
    const { items } = await client.media(target.ig_user_id);
    const after = items.filter(item => item.timestamp && Date.parse(item.timestamp) > Date.parse(target.activated_at) && item.product !== 'STORY')
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (!after.length) return false;
    const [post] = after;
    return rest.rpc('instagram_automations_bind_next', { p_automation: target.automation_id, p_media_id: post.id,
      p_preview: { caption: post.caption, thumbnailUrl: post.thumbnailUrl, permalink: post.permalink, timestamp: post.timestamp } });
  }

  async function pollTarget(target) {
    const client = new GraphClient({ token: target.token, version, fetchImpl: fetcher });
    if (target.media === 'next') return (await bindNext(client, target), 0);
    const medias = target.media === 'live' ? (await client.liveMedia(target.ig_user_id)).map(item => ({ id: item.id, live: true }))
      : target.media_id ? [{ id: target.media_id, live: false }] : [];
    let total = 0;
    for (const media of medias) total += await pollMedia(client, target, media);
    return total;
  }

  async function run(deadline, now = () => Date.now()) {
    const targets = await rest.rpc('instagram_automations_comment_targets');
    const seen = new Set();
    let found = 0;
    const errors = [];
    for (const target of targets) {
      const key = `${target.media}:${target.media_id || target.ig_user_id}`;
      if (seen.has(key) || now() > deadline || !target.token) continue;
      seen.add(key);
      try {
        found += await pollTarget(target);
      } catch (error) {
        errors.push(String(error?.message || error).slice(0, 120));
      }
    }
    return { found, errors };
  }

  return { run, pollTarget };
}
