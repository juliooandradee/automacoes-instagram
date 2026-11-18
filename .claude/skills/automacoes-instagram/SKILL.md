---
name: automacoes-instagram
description: Cria, testa, ativa e pausa automações do Instagram que respondem no Direct quem comenta uma palavra em post, Reels ou live, quem manda uma palavra no Direct e quem responde ou menciona o perfil em Stories, e cuida das conversas, usando as automações instaladas na pasta automacoes-instagram (API oficial da Meta, Supabase da própria pessoa). Use quando a pessoa pedir "comente X e receba no Direct", resposta automática no Direct ou em Stories, abrir o quadro das automações, ver ou responder conversas do Instagram, pausar ou ativar uma automação, ou apagar os dados de alguém que pediu. Não use para publicar posts.
---

# Automações do Instagram

As automações ficam na pasta `~/automacoes-instagram` (se a pessoa instalou em outro lugar, o caminho está no fim deste arquivo). Rode todos os comandos de dentro dela. Quem responde é o Supabase da pessoa, 24 horas: o computador pode estar desligado.

Se a pasta não existir ou `npm run status` disser que falta configurar, siga o `INSTALAR.md` dessa pasta.

## Antes de tudo

1. `npm run status` mostra o Instagram conectado, o agendador e as automações. Se aparecer "não conectado", rode `npm run conectar -- --instagram @perfil` e espere a pessoa autorizar na tela da Meta.
2. Se a pessoa preferir clicar, abra o quadro: rode `npm run quadro` em segundo plano (ele fica no ar até Ctrl+C) e passe o endereço `http://127.0.0.1:4321`.

## Criar uma automação

1. Entenda o pedido e confirme numa mensagem só: o gatilho, as palavras, o texto de cada mensagem, os botões e os links, e a resposta pública (se for comentário).
2. Comentário em um post específico ou resposta a um Story específico: `npm run posts` (ou `npm run posts -- --stories`) lista as publicações com o id, a data e o começo da legenda. Escolha com a pessoa.
3. Escreva o arquivo em `minhas-automacoes/<nome>.json`, partindo do exemplo mais parecido em `exemplos/` (formato abaixo).
4. `npm run salvar -- minhas-automacoes/<nome>.json`. Ele cria a automação desligada e diz se ela já pode ser ativada; se não puder, diz o motivo. Corrija o arquivo e salve de novo com `--id <id>`.
5. Teste: `npm run testar -- <id> --pessoas @perfilpessoal`. No teste, só essas pessoas (de 1 a 5, que já falaram com o perfil) recebem as mensagens. Peça para a pessoa comentar ou mandar a palavra e confira com `npm run conversa -- @perfilpessoal`.
6. Ative para todos só depois do "sim": `npm run ativar -- <id>`.

Para mudar uma automação: `npm run ver -- <id>`, copie o JSON para um arquivo, edite e salve com `npm run salvar -- arquivo.json --id <id>`. Se ela estava ativa ou em teste, a mudança só vale depois de `npm run ativar -- <id>` (ou `testar`) de novo.

| Pedido | Comando |
|---|---|
| Listar e ver os resultados | `npm run automacoes` |
| Pausar (desligar) | `npm run pausar -- <id>` |
| Mandar para a lixeira / trazer de volta | `npm run arquivar -- <id>` / `npm run arquivar -- <id> --restaurar` |
| Rodar agora o que roda a cada minuto | `npm run processar` |

O `<id>` aceita os 8 primeiros caracteres mostrados em `npm run automacoes`.

## Formato do arquivo

```json
{
  "name": "Comente QUERO",
  "trigger": "comment",
  "media": "specific",
  "mediaId": "18000000000000000",
  "match": "contains",
  "keywords": "quero, eu quero",
  "publicReplies": ["Te chamei no Direct!", "Te mandei uma mensagem no Direct!"],
  "blocks": [
    { "id": "b1", "type": "message", "text": "Oi! Toque no botão que eu te mando o link aqui.",
      "buttons": [{ "id": "r1", "type": "reply", "title": "Quero o link", "target": "b2" }], "next": null, "tag": "" },
    { "id": "b2", "type": "message", "text": "Aqui está!",
      "buttons": [{ "id": "l1", "type": "link", "title": "Abrir o link", "url": "https://seusite.com.br/material" }], "next": null, "tag": "recebeu-link" }
  ]
}
```

| Campo | Valores |
|---|---|
| `trigger` | `comment` (comentário), `direct`, `story_reply` (resposta a Story), `story_mention` (menção em Story) |
| `media` | comentário: `specific` (um post ou Reels, com `mediaId`), `next` (o próximo post publicado) ou `live` (qualquer live); resposta a Story: `all` ou `specific` (com `mediaId`); nos outros, omita |
| `match` | `contains` (contém uma das palavras), `exact` (é exatamente a palavra) ou `any` (qualquer mensagem). Menção em Story: sempre `any` |
| `keywords` | palavras separadas por vírgula; acento e maiúscula não importam |
| `publicReplies` | só para comentário fora da live: uma é sorteada a cada comentário, sem repetir a última; lista vazia = sem resposta pública |
| `blocks` | de 1 a 20 etapas; a primeira é a primeira mensagem |
| `type` | `message` ou `handoff` (passa para a equipe: a automação para para essa pessoa e a conversa fica em Conversas) |
| `buttons` | até 3: `reply` (leva para a etapa `target`) ou `link` (`url` https, com clique contado) |
| `next` | a etapa enviada logo em seguida, só em mensagem sem botão de resposta |
| `tag` | etiqueta opcional que marca quem recebeu a etapa |

Regras que o `salvar` confere: texto de até 1.000 caracteres (640 com botões), títulos de botão de até 20 caracteres e diferentes entre si, todas as etapas ligadas à primeira, sem voltar para uma etapa anterior, e link `https` (o `exemplo.com` dos exemplos é recusado de propósito). Depois de um comentário, a primeira mensagem é a única resposta privada que o Instagram permite: para continuar, ela precisa de um botão de resposta, e os links vão na mensagem seguinte (uma primeira mensagem só com botão de link também vale).

## Conversas

| Pedido | Comando |
|---|---|
| Quem falou com o perfil | `npm run contatos` (ou `-- --busca nome`) |
| Ver uma conversa | `npm run conversa -- @fulano` |
| Responder | `npm run responder -- @fulano --texto "..."` |
| Pausar ou retomar a automação para uma pessoa | `npm run pausar-contato -- @fulano` / `-- @fulano --retomar` |
| Apagar os dados de quem pediu | `npm run apagar-contato -- @fulano --sim` |

- Responder só com o texto que a pessoa aprovou. Ao responder, a automação pausa para aquele contato.
- O Instagram só aceita mensagem comum até 24 horas depois da última mensagem da pessoa. Passou disso, o erro diz `JANELA_ENCERRADA`: explique que é preciso esperar ela escrever de novo.

## Depois de rodar

Responda em até 3 linhas: o que foi criado ou mudou (nome, gatilho, palavras), o modo (desligada, em teste com quem, ativa) e o próximo passo. Erros vêm em português e dizem o que fazer: repasse sem repetir às cegas.

## Regras

- Nunca mostre, copie nem peça o conteúdo do `.env`. Nunca peça a senha do Instagram ou do Facebook: a conexão é sempre pela tela oficial da Meta.
- Nunca ative para o público, responda conversas, apague dados ou desconecte (`npm run desconectar -- --sim`) sem pedido explícito da pessoa.
- Os arquivos de `exemplos/` são modelos: copie para `minhas-automacoes/` antes de editar.

Pasta das automações: ~/automacoes-instagram
