# Automações do Instagram: instruções para o agente

Projeto que responde comentários (post, Reels e live), Direct, respostas e menções em Stories do Instagram, no Direct, pela API oficial da Meta. Roda no Supabase da própria pessoa (banco, cofre, agendador e uma função) e tem um quadro local no navegador. A pessoa usa pelo quadro ou pelo Claude Code e pelo Codex.

## O que fazer

- **Instalar ou reinstalar:** siga o [INSTALAR.md](INSTALAR.md) do começo ao fim.
- **Criar, testar, ativar, pausar automações, abrir o quadro, ver ou responder conversas:** siga a skill `automacoes-instagram` (`.agents/skills/automacoes-instagram/SKILL.md` no Codex, `.claude/skills/automacoes-instagram/SKILL.md` no Claude Code; as duas são iguais).
- **Ajuda dos comandos:** `npm run ajuda`.

## Regras que valem sempre

- Nunca peça a senha do Instagram ou do Facebook; a conexão é pela tela oficial da Meta (`npm run conectar`).
- Nunca mostre, copie nem envie o conteúdo do `.env`. Ele nunca vai para o Git.
- Nunca ative uma automação para o público (`npm run ativar`) sem a pessoa confirmar o gatilho, as palavras e as mensagens. Teste antes no modo teste.
- Nunca responda uma conversa (`npm run responder`), apague dados (`npm run apagar-contato`) nem desconecte sem pedido explícito da pessoa.
- Erros dos comandos saem em português e dizem o que fazer. Repasse; não repita às cegas.

## Como o código está organizado

- `supabase/migrations/`: banco (tabelas no esquema privado `instagram_automations`, funções `public.instagram_automations_*` só para a chave secreta, cofre e agendador pg_cron).
- `supabase/functions/automacoes/`: a função única (webhook da Meta, volta da conexão, links rastreados, política de privacidade, agendador e comandos). A lógica fica em `supabase/functions/_shared/` (`flows.mjs` valida e casa as automações, `engine.mjs` executa e envia, `poll.mjs` busca comentários, `panel.mjs` atende o quadro).
- `src/` e `bin/`: a linha de comando (`npm run ...`) e o servidor local do quadro (`src/quadro.mjs`), sem dependências.
- `painel/`: o quadro (HTML, CSS e JavaScript puros).
- `exemplos/`: automações prontas para copiar (o formato está na skill).
- `tests/`: `npm test` (Node 22+; os de ponta a ponta usam um Postgres local se houver) e `npm run test:banco`.

Antes de mudar código: `npm test` e, se mexer na função, `deno check supabase/functions/automacoes/index.ts`. Depois de mudar a função ou a migração, publique com `npm run supabase:instalar`.
