// Comandos da linha de comando. Cada um recebe as opções já lidas e o contexto (api, log, env, fuso).
import crypto from 'node:crypto';
import { answer } from './api.mjs';
import { describeAutomation, describeContact, describeMedia, describeMessage, formatWhen, normalizeHandle, shortId } from './format.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IG_ID = /^[0-9]{5,40}$/;
const call = async (ctx, action, body = {}) => answer(await ctx.api.call(action, body));
const accountOf = options => options.account || 'principal';

function describeAccount(account, timeZone) {
  if (account.status !== 'connected') {
    const waiting = account.pending ? ' A Meta aprovou, mas falta escolher o Instagram: npm run conectar -- --retomar' : '';
    const expired = account.status === 'expired' ? ' A Meta pediu nova autorização: npm run conectar' : '';
    return `Instagram (conta ${account.account}): não conectado.${waiting}${expired}`;
  }
  const events = account.subscribed ? 'eventos do Direct e dos Stories chegando' : 'eventos ainda não inscritos (npm run conferir)';
  const error = account.last_error ? ` Último aviso: ${account.last_error}.` : '';
  return `Instagram (conta ${account.account}): @${account.username}, conectado em ${formatWhen(account.connected_at, timeZone)}, ${events}.${error}`;
}

export async function statusCommand(ctx) {
  const status = await call(ctx, 'status');
  ctx.log(`Projeto: ${ctx.env.SUPABASE_URL}`);
  ctx.log(`App da Meta: ${status.meta_configured ? 'configurado.' : 'falta configurar (npm run configurar).'}`);
  ctx.log(`Agendador: ${status.scheduler_ready ? 'ativo: a cada minuto busca comentários e envia a fila.' : 'ainda não ativo (npm run configurar).'}`);
  if (!status.accounts.length) ctx.log('Instagram: nenhum conectado (npm run conectar -- --instagram @seuperfil).');
  for (const account of status.accounts) ctx.log(describeAccount(account, ctx.timeZone));
  const counts = status.automations;
  ctx.log(`Automações: ${counts.live} ativa(s), ${counts.test} em teste, ${counts.off} desligada(s). Mensagens na fila: ${status.queue}.`);
  ctx.log(`Último evento recebido: ${status.last_event_at ? formatWhen(status.last_event_at, ctx.timeZone) : 'nenhum ainda'}.`);
  return status;
}

function metaFromEnv(env) {
  const values = { app_id: env.META_APP_ID?.trim(), app_secret: env.META_APP_SECRET?.trim(), config_id: env.META_CONFIG_ID?.trim(),
    graph_version: env.META_GRAPH_VERSION?.trim() || 'v26.0' };
  if (!values.app_id && !values.config_id && !values.app_secret) return null;
  const missing = [['META_APP_ID', values.app_id], ['META_CONFIG_ID', values.config_id]].filter(([, value]) => !value);
  if (missing.length) throw new Error(`Falta preencher no .env: ${missing.map(([name]) => name).join(', ')}.`);
  return values;
}

export async function configureCommand(ctx) {
  const meta = metaFromEnv(ctx.env);
  const result = await call(ctx, 'configure', meta || {});
  ctx.log('A função automacoes está no ar e o agendador foi ligado (roda a cada minuto).');
  ctx.log('Copie no app da Meta, igualzinho:');
  ctx.log(`  Login → URIs de redirecionamento do OAuth válidos:\n    ${result.redirect_uri}`);
  ctx.log(`  Webhooks → URL de retorno de chamada:\n    ${result.webhook_url}`);
  ctx.log(`  Webhooks → Token de verificação:\n    ${result.verify_token}`);
  ctx.log(`  Configurações do app → Básico → URL da Política de Privacidade e URL de exclusão de dados:\n    ${result.privacy_url}`);
  if (!result.meta_configured) {
    ctx.log('Falta o app da Meta: preencha META_APP_ID, META_APP_SECRET e META_CONFIG_ID no .env e rode de novo.');
    return result;
  }
  ctx.log('O app da Meta foi conferido com a própria Meta e guardado no cofre (Vault) do seu Supabase.');
  if (ctx.env.META_APP_SECRET) {
    ctx.writeEnv('META_APP_SECRET', '');
    ctx.log('Tirei a chave secreta do arquivo .env: ela já está guardada no cofre.');
  }
  ctx.log('Próximo passo: npm run conectar -- --instagram @seuperfil');
  return result;
}

async function waitForConnection(ctx, account, since, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const status = await call(ctx, 'status');
    const found = status.accounts.find(item => item.account === account);
    if (found?.status === 'connected' && Date.parse(found.connected_at) >= since - 5000) return found;
    if (found?.pending_at && Date.parse(found.pending_at) >= since - 5000) {
      ctx.log('A Meta aprovou, mas o Instagram certo ainda não apareceu. Leia a mensagem na janela da Meta e depois rode: npm run conectar -- --retomar');
      return null;
    }
    await ctx.sleep(3000);
  }
  return null;
}

export async function connectCommand(options, ctx) {
  const account = accountOf(options);
  const expected = options.instagram ? normalizeHandle(options.instagram) : null;
  if (options.resume) {
    const result = await call(ctx, 'resume', { account, expected_username: expected });
    ctx.log(result.message || `Conectado: @${result.username}.`);
    return result;
  }
  const started = Date.now();
  const link = await call(ctx, 'connect', { account, expected_username: expected });
  ctx.log('Abra este link e autorize na tela oficial da Meta (vale 30 minutos):');
  ctx.log(link.url);
  if (!options.noBrowser) ctx.openUrl(link.url);
  ctx.log('Na Meta: entre com o Facebook que administra a Página ligada ao Instagram, marque essa Página e esse Instagram e salve.');
  const connected = await waitForConnection(ctx, account, started, options.wait ?? 90);
  if (!connected) {
    ctx.log('Ainda não vi a conexão. Quando terminar na Meta, rode: npm run status');
    return { connected: false, url: link.url };
  }
  ctx.log(`Conectado: @${connected.username} (conta ${connected.account}).`);
  await checkCommand({ account }, ctx).catch(error => ctx.log(`Não consegui conferir com a Meta agora: ${error.message}`));
  return { connected: true, username: connected.username };
}

export async function checkCommand(options, ctx) {
  const result = await call(ctx, 'check', { account: accountOf(options) });
  const followers = result.followers != null ? `, ${result.followers} seguidores` : '';
  const posts = result.media_count != null ? `, ${result.media_count} publicações` : '';
  ctx.log(`A Meta confirmou o acesso ao @${result.username}${followers}${posts}.`);
  ctx.log(result.subscribed ? 'A Página está inscrita: mensagens do Direct, respostas e menções em Stories chegam na hora.'
    : 'A Página ainda não aceitou a inscrição dos eventos. Confira os Webhooks no app da Meta (e se o app está no modo Ativo) e rode de novo.');
  return result;
}

export async function postsCommand(options, ctx) {
  const result = await call(ctx, options.stories ? 'stories' : 'media', { account: accountOf(options), after: options.after });
  if (result.warning) ctx.log(result.warning);
  if (!result.items.length) ctx.log(options.stories ? 'Nenhum Story no ar agora (Stories somem em 24 horas).' : 'Nenhuma publicação encontrada.');
  for (const item of result.items) ctx.log(describeMedia(item, ctx.timeZone));
  if (result.after) ctx.log(`Mais antigas: npm run posts -- --depois ${result.after}`);
  return result;
}

export async function listCommand(options, ctx) {
  const items = await call(ctx, 'automations', { account: accountOf(options), archived: !!options.archived });
  if (!items.length) {
    ctx.log(options.archived ? 'A lixeira está vazia.' : 'Nenhuma automação ainda. Monte no quadro (npm run quadro) ou parta de um exemplo: npm run salvar -- exemplos/comentario-palavra-chave.json');
  }
  for (const item of items) ctx.log(describeAutomation(item, ctx.timeZone));
  return items;
}

// Aceita o id inteiro ou os 8 primeiros caracteres que a lista mostra.
async function findAutomation(ctx, options, id) {
  const value = String(id || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(value)) throw new Error('Informe a automação pelo id (os 8 caracteres que aparecem em npm run automacoes).');
  if (UUID.test(value)) return call(ctx, 'automation', { id: value }).then(item => item || Promise.reject(new Error('Automação não encontrada.')));
  for (const archived of [false, true]) {
    const items = await call(ctx, 'automations', { account: accountOf(options), archived });
    const found = items.filter(item => item.id.startsWith(value));
    if (found.length > 1) throw new Error('Mais de uma automação começa assim; use mais caracteres do id.');
    if (found.length) return found[0];
  }
  throw new Error(`Nenhuma automação com id ${value}. Veja os ids com: npm run automacoes`);
}

export async function showCommand(options, ctx) {
  const item = await findAutomation(ctx, options, options.id);
  ctx.log(describeAutomation(item, ctx.timeZone));
  ctx.log(JSON.stringify(item.draft, null, 2));
  return item;
}

export async function saveCommand(options, ctx) {
  if (!options.file) throw new Error('Informe o arquivo da automação: npm run salvar -- minha-automacao.json');
  let draft;
  try {
    draft = JSON.parse(ctx.readFile(options.file));
  } catch (error) {
    throw new Error(`Não consegui ler ${options.file} como JSON: ${error.message}`);
  }
  const current = options.id ? await findAutomation(ctx, options, options.id) : null;
  const saved = await call(ctx, 'save', { account: accountOf(options), id: current?.id, revision: current?.revision, draft });
  ctx.log(`${current ? 'Atualizada' : 'Criada'}: ${shortId(saved.id)} · "${saved.draft.name}" · ${saved.mode === 'off' ? 'desligada' : 'mudança salva como rascunho'}.`);
  try {
    await call(ctx, 'validate', { draft: saved.draft });
    ctx.log(`Pronta para testar: npm run testar -- ${shortId(saved.id)} --pessoas @alguem (ou ativar: npm run ativar -- ${shortId(saved.id)})`);
  } catch (error) {
    ctx.log(`Salva como rascunho, mas ainda não dá para ativar: ${error.message}`);
  }
  return saved;
}

async function resolveRecipients(ctx, options) {
  const wanted = String(options.people || '').split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
  if (!wanted.length || wanted.length > 5) throw new Error('No teste, informe de 1 a 5 pessoas: --pessoas @fulano,@ciclana');
  const recipients = [];
  for (const person of wanted) recipients.push(IG_ID.test(person) ? person : (await findContact(ctx, options, person)).igsid);
  return recipients;
}

export async function publishCommand(options, ctx) {
  const item = await findAutomation(ctx, options, options.id);
  const recipients = options.mode === 'test' ? await resolveRecipients(ctx, options) : [];
  const result = await call(ctx, 'publish', { account: accountOf(options), id: item.id, mode: options.mode, test_recipients: recipients });
  const name = `"${result.draft.name}"`;
  if (options.mode === 'off') ctx.log(`${name} desligada. Quem estava no meio do fluxo não recebe mais nada dela.`);
  if (options.mode === 'test') ctx.log(`${name} em teste: só responde a ${recipients.length} pessoa(s). Peça para elas comentarem ou mandarem a palavra.`);
  if (options.mode === 'live') ctx.log(`${name} ativa para todos. Acompanhe com: npm run automacoes`);
  return result;
}

export async function archiveCommand(options, ctx) {
  const item = await findAutomation(ctx, options, options.id);
  const result = await call(ctx, 'archive', { id: item.id, archived: !options.restore });
  ctx.log(options.restore ? `"${result.draft.name}" voltou da lixeira (desligada).` : `"${result.draft.name}" foi para a lixeira. Para trazer de volta: npm run arquivar -- ${shortId(item.id)} --restaurar`);
  return result;
}

export async function contactsCommand(options, ctx) {
  const items = await call(ctx, 'contacts', { account: accountOf(options), search: normalizeHandle(options.search || '') });
  if (!items.length) ctx.log('Ninguém ainda. Quem comentar, mandar Direct ou responder um Story aparece aqui.');
  for (const contact of items) ctx.log(describeContact(contact, ctx.timeZone));
  return items;
}

async function findContact(ctx, options, person) {
  const handle = normalizeHandle(person);
  const items = await call(ctx, 'contacts', { account: accountOf(options), search: handle });
  const found = items.find(item => item.igsid === handle || (item.username || '').toLowerCase() === handle);
  if (!found) throw new Error(`Não achei @${handle} entre quem já falou com o seu Instagram. Peça para a pessoa mandar uma mensagem antes.`);
  return found;
}

export async function threadCommand(options, ctx) {
  const contact = await findContact(ctx, options, options.person);
  const thread = await call(ctx, 'thread', { contact_id: contact.id });
  ctx.log(describeContact(thread.contact, ctx.timeZone));
  for (const message of thread.messages) ctx.log(describeMessage(message, ctx.timeZone));
  return thread;
}

export async function replyCommand(options, ctx) {
  const contact = await findContact(ctx, options, options.person);
  const text = String(options.text || '').trim();
  if (!text) throw new Error('Escreva a resposta: npm run responder -- @fulano --texto "Oi! Tudo bem?"');
  const result = await call(ctx, 'reply', { contact_id: contact.id, text, request_id: crypto.randomUUID() });
  ctx.log(`Resposta enviada para a fila de @${contact.username || contact.igsid}. A automação fica pausada para essa pessoa até você retomar.`);
  return result;
}

export async function pauseContactCommand(options, ctx) {
  const contact = await findContact(ctx, options, options.person);
  const result = await call(ctx, 'pause_contact', { contact_id: contact.id, paused: !options.resume });
  ctx.log(options.resume ? `Automação retomada para @${contact.username || contact.igsid}.` : `Automação pausada para @${contact.username || contact.igsid}.`);
  return result;
}

export async function forgetCommand(options, ctx) {
  const contact = await findContact(ctx, options, options.person);
  const who = `@${contact.username || contact.igsid}`;
  if (!options.yes) throw new Error(`Isso apaga para sempre a conversa e os dados de ${who}. Para confirmar: npm run apagar-contato -- ${who} --sim`);
  const result = await call(ctx, 'forget_contact', { contact_id: contact.id, confirm: true });
  ctx.log(`Dados de ${who} apagados (${result.messages} mensagem(ns)). Se a pessoa escrever de novo, ela volta como contato novo.`);
  return result;
}

export async function tickCommand(ctx) {
  const result = await call(ctx, 'tick');
  ctx.log(`Comentários novos: ${result.comments}. Eventos processados: ${result.events}. Mensagens da fila processadas: ${result.sent}.`);
  if (result.poll_errors?.length) ctx.log(`Avisos ao buscar comentários: ${result.poll_errors.join('; ')}.`);
  return result;
}

export async function disconnectCommand(options, ctx) {
  if (!options.yes) throw new Error('Isso desliga todas as automações e apaga a chave do Instagram do cofre. Para confirmar: npm run desconectar -- --sim');
  const result = await call(ctx, 'disconnect', { account: accountOf(options), confirm: true });
  ctx.log(`Desconectado${result.username ? ` o @${result.username}` : ''}. As automações ficaram desligadas; para voltar: npm run conectar`);
  return result;
}
