# Automações do Instagram

Responda **comentários, Direct e Stories** do seu Instagram no automático, pela **API oficial da Meta**, sem ferramenta paga e sem deixar o computador ligado. Você monta as automações num quadro no navegador (ou pedindo ao Claude Code ou ao Codex) e o seu próprio Supabase responde 24 horas.

- **Comentário em post, Reels ou live** → resposta no Direct, com resposta pública opcional no comentário (sorteada de uma lista, sem repetir).
- **Palavra no Direct**, **resposta a Story** e **menção em Story** → mensagem automática.
- Mensagens com até **3 botões** (resposta ou link), fluxos com várias etapas e **"passar para mim"** quando a conversa precisa de gente.
- **Modo teste:** a automação responde só a até 5 pessoas que você escolhe, antes de valer para todos.
- **Conversas:** veja tudo o que chegou e saiu, responda pelo quadro, pause a automação para uma pessoa e apague os dados de quem pedir.
- **Links rastreados:** quantas pessoas entraram em cada automação, quantas mensagens saíram e quantas clicaram.
- A chave do Instagram fica no cofre (Vault) do seu Supabase. Ninguém pede sua senha do Instagram ou do Facebook.

## Como funciona

```
Instagram (Meta)                     Seu Supabase (grátis)                              Você
  Direct, Story, botões  ── webhook ──►  função "automacoes"  ◄── comandos ──  quadro no navegador
  comentários e lives  ◄── busca a cada minuto ──  agendador (pg_cron)           Claude Code ou Codex
  mensagens no Direct  ◄── envio, uma por vez ──  fila + cofre (chave do Instagram)
```

## Instalar copiando e colando

Abra o **Claude Code** ou o **Codex** na sua pasta de usuário e cole:

```text
Quero instalar as Automações do Instagram no meu computador.

1. Baixe o projeto para a pasta automacoes-instagram, dentro da minha pasta de usuário:
   git clone https://github.com/juliooandradee/automacoes-instagram
   (se a pasta já existir, entre nela e rode git pull).
2. Abra o arquivo INSTALAR.md dessa pasta e siga do começo ao fim, na ordem.
3. Faça você tudo o que der pelo terminal. Quando precisar de mim (entrar no Supabase, criar o app na Meta, ligar uma opção no Instagram, autorizar a conexão), me diga exatamente onde clicar e espere.
4. Nunca me peça a senha do Instagram ou do Facebook. As chaves eu colo no arquivo .env, não aqui no chat.
5. Não ative nenhuma automação para o público sem eu pedir. Os testes são no modo teste, só com o meu perfil pessoal.
6. No fim, abra o quadro e instale a skill automacoes-instagram para eu criar automações de qualquer pasta.

Meu Instagram profissional: @
Meu Instagram pessoal (para os testes): @
```

Você vai precisar de: Instagram **profissional** ligado a uma **Página do Facebook** que você administra, um segundo Instagram (o pessoal serve) para testar, uma conta grátis no [Supabase](https://supabase.com) e uma conta de desenvolvedor na [Meta](https://developers.facebook.com) (a mesma do seu Facebook). A instalação leva de 30 a 50 minutos; a maior parte é a criação do app na Meta, que o agente explica clique por clique.

## No dia a dia

Peça em português:

- "Quem comentar EU QUERO no meu último Reels recebe este link no Direct."
- "Cria uma automação para quem mandar AGENDA no Direct, com os botões Horários e Endereço."
- "Abre o quadro." / "Mostra as conversas de hoje." / "Pausa a automação do guia."

Ou rode você mesmo, dentro da pasta:

```bash
npm run quadro
npm run automacoes
npm run ajuda
```

## Custos e limites

- **Supabase:** cabe no plano grátis (banco, função e agendador).
- **Meta:** a API é gratuita. O app precisa estar **publicado** (modo Ativo) para a Meta mandar os eventos do Direct. Para usar no seu próprio perfil não é preciso análise do app.
- **Comentários** são buscados a cada minuto (a Meta só manda o aviso de comentário na hora para apps com acesso avançado). Na prática, a resposta chega em até 1 minuto.
- **Regras do Instagram que as automações seguem:** resposta privada a um comentário só uma vez e em até 7 dias (na live, só enquanto ela está no ar); depois dela, a conversa continua quando a pessoa toca um botão de resposta; mensagens comuns só até 24 horas depois da última mensagem da pessoa.
- **Travas de segurança:** no máximo 100 mensagens automáticas por hora por perfil, 3 entradas por pessoa na mesma automação por hora e uma automação ativa por gatilho e palavra.
- Anúncios (conversas iniciadas por anúncio), respostas por IA e envio em massa não estão incluídos.

## Segurança e privacidade

- A chave do Instagram e a chave secreta do app da Meta ficam no **Vault** do seu Supabase. O arquivo `.env` (que nunca vai para o Git) guarda só a chave secreta do Supabase.
- As tabelas ficam num esquema privado, fora da API pública, e só a chave secreta do projeto chama as funções. Os eventos da Meta são aceitos só com a assinatura do seu app.
- O quadro roda só no seu computador (`127.0.0.1`) e conversa com o Supabase pela linha de comando; a chave nunca vai para o navegador.
- A função publica uma página simples de política de privacidade (o app da Meta pede uma). Pedido de exclusão: `npm run apagar-contato -- @fulano --sim` ou o botão "Apagar dados" nas Conversas. Registros técnicos de recebimento são apagados em 30 dias.
- Para desfazer: `npm run desconectar -- --sim` e, no Facebook, remova o app em **Integrações comerciais**.

## O que foi testado

- Testes automáticos do modelo das automações e de ponta a ponta (`npm test`): a função de verdade contra o banco de verdade num Postgres local, com a Meta simulada — conexão pela Página, comentário com botão e link rastreado, Direct no modo teste, Story com "passar para mim", resposta pelo celular pausando a automação, janela de 24 horas, assinatura do webhook, política de privacidade e exclusão de dados.
- Testes do banco (`npm run test:banco`) e a migração aplicada duas vezes seguidas sem erro.
- O quadro e a linha de comando usados de ponta a ponta contra essa mesma função local.
- Num projeto novo do Supabase (plano grátis): a migração aplicada duas vezes, o verificador de segurança do Supabase sem nenhum alerta, a função publicada respondendo à verificação do webhook, à assinatura da Meta, à política de privacidade, aos links e às chamadas sem chave; o agendador acordando a função a cada minuto; e um Direct de teste percorrendo o caminho inteiro até a API de verdade da Meta (que recusou a chave falsa do teste, e a conexão ficou marcada para reconectar, como previsto).
- As regras de envio vêm de um quadro de automações que já roda num perfil real. A instalação completa com um app novo da Meta, do zero, ainda não foi feita com este pacote: se algum menu da Meta estiver diferente, o agente procura pelo nome da permissão.

## Para quem quer mexer no código

```bash
npm test                 # Node 22+, sem dependências (os testes de ponta a ponta usam o Postgres local se houver)
npm run test:banco       # precisa do Postgres 15+ local (macOS: brew install postgresql@16)
deno check supabase/functions/automacoes/index.ts
```

Estrutura: `supabase/migrations/` (banco), `supabase/functions/` (função única), `src/` e `bin/` (linha de comando e servidor do quadro), `painel/` (o quadro), `exemplos/` (automações prontas para copiar), `.claude/skills/` e `.agents/skills/` (a mesma skill para Claude Code e Codex), `INSTALAR.md` (roteiro que o agente segue).

Licença MIT.
