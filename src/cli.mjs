// Linha de comando das automações: lê os argumentos, monta o contexto e chama o comando.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createApi } from './api.mjs';
import * as commands from './commands.mjs';
import { readEnv, requireEnv, writeEnvValue } from './env.mjs';
import { DEFAULT_TIME_ZONE, checkTimeZone } from './format.mjs';
import { startPanel } from './quadro.mjs';
import { installCommand, prepareCommand, projectCommand, saveKeyCommand } from './setup.mjs';

export const HELP = `Automações do Instagram: comentário em post, Reels e live, Direct e Stories respondidos no Direct, no seu Supabase.

Uso: npm run <comando> -- [opções]

Instalação (uma vez):
  preparar                    Cria o .env e uma senha forte para o banco.
  supabase:projeto --org <id> Cria um projeto grátis no Supabase (ou --ref <id> para usar um que já existe).
  supabase:instalar           Aplica o banco, publica a função e guarda a chave secreta no .env.
  configurar                  Liga o agendador, guarda o app da Meta (lê o .env) e mostra o que colar na Meta.
  conectar --instagram @x     Abre a tela oficial da Meta para conectar o Instagram.
           --retomar          Termina uma conexão que ficou esperando, sem novo login.
  conferir                    Pergunta à Meta se o acesso está ok e se os eventos estão inscritos.

Quadro (tela no navegador, só no seu computador):
  quadro [--porta 4321]       Abre o quadro para montar, testar e ativar as automações e ver as conversas.

Automações pela linha de comando:
  automacoes [--lixeira]      Lista as automações com modo e resultados.
  posts [--stories]           Lista publicações (ou Stories no ar) com o id para usar na automação. --depois <cursor> para mais.
  salvar <arquivo.json>       Cria uma automação a partir do arquivo (veja a pasta exemplos/). --id <id> atualiza uma existente.
  ver <id>                    Mostra a automação em JSON.
  testar <id> --pessoas @a,@b Ativa só para 1 a 5 pessoas que já falaram com o seu Instagram.
  ativar <id>                 Ativa para todo mundo.
  pausar <id>                 Desliga (quem estava no meio do fluxo para de receber).
  arquivar <id> [--restaurar] Manda para a lixeira (ou traz de volta). Só com a automação desligada.

Conversas:
  contatos [--busca nome]     Quem falou com o seu Instagram.
  conversa @fulano            Mostra a conversa.
  responder @fulano --texto "..."   Responde no Direct (até 24 horas depois da última mensagem da pessoa).
  pausar-contato @fulano [--retomar] Pausa (ou retoma) a automação só para essa pessoa.
  apagar-contato @fulano --sim  Apaga a conversa e os dados da pessoa (pedido de exclusão, LGPD).

Manutenção:
  status                      Conexão, agendador, automações e fila.
  processar                   Roda agora o que o agendador roda a cada minuto.
  desconectar --sim           Desliga tudo e apaga a chave do Instagram do cofre.

Em todos: --conta <nome> (padrão: principal) e --json (saída para programas).`;

const ACCOUNT = { conta: { type: 'string' } };
const ID_COMMAND = mode => ({ options: { ...ACCOUNT, pessoas: { type: 'string' } },
  run: (values, ctx, [id]) => commands.publishCommand({ account: values.conta, id, mode, people: values.pessoas }, ctx) });
const PERSON = handler => (values, ctx, [person]) => handler({ account: values.conta, person, text: values.texto, resume: values.retomar }, ctx);

// Comandos de instalação: rodam antes de o .env estar completo.
const SETUP = {
  preparar: { options: {}, run: (values, ctx) => prepareCommand(ctx) },
  'supabase-projeto': {
    options: { org: { type: 'string' }, ref: { type: 'string' }, regiao: { type: 'string' }, nome: { type: 'string' } },
    run: (values, ctx) => projectCommand({ org: values.org, ref: values.ref, region: values.regiao, name: values.nome }, ctx),
  },
  'supabase-instalar': { options: {}, run: (values, ctx) => installCommand(ctx) },
  'salvar-chave': {
    options: { ref: { type: 'string' } },
    run: (values, ctx) => {
      if (process.stdin.isTTY) throw new Error('Use com a saída da CLI: npx supabase@3.2.0 projects api-keys --reveal -o json | npm run --silent salvar-chave');
      return saveKeyCommand({ ref: values.ref }, { ...ctx, input: fs.readFileSync(0, 'utf8') });
    },
  },
};

const SPECS = {
  status: { options: {}, run: (values, ctx) => commands.statusCommand(ctx) },
  configurar: { options: {}, run: (values, ctx) => commands.configureCommand(ctx) },
  conectar: {
    options: { ...ACCOUNT, instagram: { type: 'string' }, retomar: { type: 'boolean' }, 'sem-navegador': { type: 'boolean' }, esperar: { type: 'string' } },
    run: (values, ctx) => commands.connectCommand({ account: values.conta, instagram: values.instagram, resume: values.retomar,
      noBrowser: values['sem-navegador'], wait: values.esperar ? Number(values.esperar) : undefined }, ctx),
  },
  conferir: { options: ACCOUNT, run: (values, ctx) => commands.checkCommand({ account: values.conta }, ctx) },
  quadro: { options: { porta: { type: 'string' }, 'sem-navegador': { type: 'boolean' } }, run: (values, ctx) => panelCommand(values, ctx) },
  automacoes: { options: { ...ACCOUNT, lixeira: { type: 'boolean' } },
    run: (values, ctx) => commands.listCommand({ account: values.conta, archived: values.lixeira }, ctx) },
  posts: { options: { ...ACCOUNT, stories: { type: 'boolean' }, depois: { type: 'string' } },
    run: (values, ctx) => commands.postsCommand({ account: values.conta, stories: values.stories, after: values.depois }, ctx) },
  salvar: { options: { ...ACCOUNT, id: { type: 'string' } },
    run: (values, ctx, [file]) => commands.saveCommand({ account: values.conta, id: values.id, file }, ctx) },
  ver: { options: ACCOUNT, run: (values, ctx, [id]) => commands.showCommand({ account: values.conta, id }, ctx) },
  testar: ID_COMMAND('test'),
  ativar: ID_COMMAND('live'),
  pausar: ID_COMMAND('off'),
  arquivar: { options: { ...ACCOUNT, restaurar: { type: 'boolean' } },
    run: (values, ctx, [id]) => commands.archiveCommand({ account: values.conta, id, restore: values.restaurar }, ctx) },
  contatos: { options: { ...ACCOUNT, busca: { type: 'string' } },
    run: (values, ctx) => commands.contactsCommand({ account: values.conta, search: values.busca }, ctx) },
  conversa: { options: ACCOUNT, run: PERSON(commands.threadCommand) },
  responder: { options: { ...ACCOUNT, texto: { type: 'string' } }, run: PERSON(commands.replyCommand) },
  'pausar-contato': { options: { ...ACCOUNT, retomar: { type: 'boolean' } }, run: PERSON(commands.pauseContactCommand) },
  'apagar-contato': { options: { ...ACCOUNT, sim: { type: 'boolean' } },
    run: (values, ctx, [person]) => commands.forgetCommand({ account: values.conta, person, yes: values.sim }, ctx) },
  processar: { options: {}, run: (values, ctx) => commands.tickCommand(ctx) },
  desconectar: { options: { ...ACCOUNT, sim: { type: 'boolean' } },
    run: (values, ctx) => commands.disconnectCommand({ account: values.conta, yes: values.sim }, ctx) },
};

// Abre o link no navegador padrão. Se não der, o link já foi mostrado na tela.
export function openUrl(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // Sem navegador: a pessoa copia o link.
  }
}

// Sobe o quadro e fica no ar até Ctrl+C (ou até quem chamou fechar o servidor).
async function panelCommand(values, ctx) {
  const port = values.porta ? Number(values.porta) : 4321;
  if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new Error('Use uma porta entre 1024 e 65000.');
  const { server, url } = await startPanel({ api: ctx.api, port });
  ctx.log(`Quadro no ar em ${url} (só neste computador). Para fechar: Ctrl+C.`);
  if (!values['sem-navegador']) ctx.openUrl(url);
  ctx.onPanel?.(server);
  await new Promise(resolve => {
    const stop = () => server.close(resolve);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', resolve);
  });
  return { url };
}

function readOptions(spec, argv) {
  try {
    return parseArgs({ args: argv, options: { ...spec.options, json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  } catch (error) {
    const option = error.message.match(/'(-{1,2}[^'\s]+)/)?.[1] || '';
    const message = error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `Opção desconhecida: ${option}.`
      : error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? `A opção ${option} precisa de um valor.` : error.message;
    throw new Error(`${message} Veja: npm run ajuda`);
  }
}

function buildContext(values, deps, log) {
  const env = requireEnv(deps.env || readEnv(), ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
  return {
    api: deps.api || createApi({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY, fetcher: deps.fetcher }),
    env, log: values.json ? () => {} : log, timeZone: checkTimeZone(env.FUSO_HORARIO || DEFAULT_TIME_ZONE),
    sleep: deps.sleep || (ms => new Promise(done => setTimeout(done, ms))), openUrl: deps.openUrl || openUrl,
    writeEnv: deps.writeEnv || writeEnvValue, readFile: file => fs.readFileSync(file, 'utf8'), onPanel: deps.onPanel,
  };
}

export async function main(argv, deps = {}) {
  const log = deps.log || (line => process.stdout.write(`${line}\n`));
  const fail = deps.fail || (line => process.stderr.write(`${line}\n`));
  const [name, ...rest] = argv;
  if (!name || ['ajuda', 'help', '-h', '--help'].includes(name)) { log(HELP); return 0; }
  const spec = SPECS[name] || SETUP[name];
  if (!spec) { fail(`Comando desconhecido: ${name}\n\n${HELP}`); return 1; }
  try {
    const { values, positionals } = readOptions(spec, rest);
    const ctx = SETUP[name] ? { log, ...(deps.envFile ? { envFile: deps.envFile } : {}), ...(deps.run ? { run: deps.run } : {}) }
      : buildContext(values, deps, log);
    const result = await spec.run(values, ctx, positionals);
    if (values.json) log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    fail(`Erro: ${error.message}`);
    return 1;
  }
}
