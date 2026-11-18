# Instalar as Automações do Instagram

Roteiro para o Claude Code ou o Codex. Siga na ordem, um passo por vez. Fale com a pessoa em português simples: diga o que vai fazer, faça e conte o resultado em uma ou duas linhas.

Ao final, a pessoa terá automações próprias, rodando 24 horas no Supabase dela, pela API oficial da Meta:

- quem **comenta** uma palavra num post, Reels ou live recebe a resposta no **Direct** (e, se ela quiser, uma resposta pública no comentário);
- quem manda uma palavra no **Direct**, **responde um Story** ou **menciona o perfil num Story** recebe uma mensagem automática;
- mensagens com até 3 botões (resposta ou link rastreado), fluxos com várias etapas e "passar para mim" quando a conversa precisa de gente;
- um **quadro** no navegador para montar, testar e ativar as automações e responder as conversas.

## Regras durante a instalação

- **Faça você tudo o que der pelo terminal.** Peça ajuda à pessoa só no que exige ela: entrar no Supabase, criar o app na Meta, ligar uma opção no app do Instagram, autorizar a conexão e mandar mensagens de teste do perfil pessoal.
- **Nunca peça a senha do Instagram nem a do Facebook.** A conexão é sempre pela tela oficial da Meta.
- **Segredos ficam no arquivo `.env`, não no chat.** Os comandos deste projeto gravam a chave do Supabase sem mostrá-la. A chave secreta do app da Meta a própria pessoa cola no `.env`. Se ela colar no chat mesmo assim, use só para gravar no `.env` e não repita.
- **Nenhuma automação responde ao público sem a pessoa pedir.** Todo teste é no modo teste, que só responde às pessoas escolhidas (o perfil pessoal dela). Para ativar para todos, mostre o resumo e espere o "sim".
- Os comandos `npm run ...` rodam **dentro da pasta `automacoes-instagram`**.
- No Codex, comandos que usam a internet podem pedir aprovação. Explique à pessoa que é para baixar a CLI do Supabase e falar com o Supabase e a Meta.

## 0. Conferir o computador

1. `node -v` precisa mostrar 22 ou mais. Se faltar: no Mac, `brew install node` (sem Homebrew, peça para instalar a versão LTS em https://nodejs.org); no Windows, o instalador LTS de https://nodejs.org. Feche e abra o terminal depois.
2. `git --version`. Se faltar: no Mac, `xcode-select --install`; no Windows, https://git-scm.com.
3. Se você está lendo isto, o repositório já está na pasta `automacoes-instagram`. Entre nela e rode `npm test`: precisa terminar com `# fail 0` (os testes que precisam de um Postgres local aparecem como pulados, e tudo bem). Não há pacotes para instalar: o projeto não tem dependências.

## 1. Supabase: o servidor grátis que responde 24 horas

1. Pergunte se a pessoa já tem conta em https://supabase.com. Se não tiver, peça para criar (pode entrar com o GitHub ou com e-mail) e escolher o plano **Free**.
2. `npm run preparar` cria o `.env` e uma senha forte para o banco.
3. `npx supabase@3.2.0 login` abre o navegador. A pessoa entra e autoriza. Se o terminal mostrar um código de verificação, mostre o código para ela digitar.
4. `npx supabase@3.2.0 orgs list` lista as organizações. Se houver uma só, use. Se houver várias, pergunte qual. Se não houver nenhuma, peça para a pessoa criar em https://supabase.com/dashboard.
5. `npm run supabase:projeto -- --org <id da organização>` cria o projeto `automacoes-instagram` em São Paulo e liga a pasta a ele. Leva uns 2 minutos.
   - O plano grátis permite 2 projetos ativos por organização. Se o Supabase recusar por limite, explique e pergunte se a pessoa prefere pausar um projeto antigo no painel ou usar um que já existe. Para usar um existente: `npm run supabase:projeto -- --ref <id do projeto>`, com a senha do banco desse projeto na linha `SUPABASE_DB_PASSWORD` do `.env` (a pessoa pode criar uma nova em Project Settings → Database → Reset database password).
6. `npm run supabase:instalar` aplica o banco (tabelas, cofre e agendador), publica a função `automacoes` e grava a chave secreta no `.env`.
   - Se ele disser que não achou a chave secreta: peça para a pessoa abrir Project Settings → API Keys → Secret keys, copiar a chave que começa com `sb_secret_` e colar no `.env`, na linha `SUPABASE_SECRET_KEY`.
7. `npm run configurar` liga o agendador e mostra quatro coisas para o app da Meta: o **endereço de retorno do login**, a **URL dos webhooks** (é o mesmo endereço), o **token de verificação** e o **endereço da política de privacidade**. Elas vão no passo 3.
8. `npm run status` precisa mostrar "Agendador: ativo".

## 2. Instagram: duas conferências no celular

Peça à pessoa para conferir, no app do Instagram do perfil que vai ter as automações:

1. O perfil é **profissional** (Empresa ou Criador de conteúdo) e está **ligado a uma Página do Facebook** que ela administra: Editar perfil → Página. Sem esse vínculo a Meta não mostra o Instagram.
2. **Permitir acesso às mensagens:** Configurações e atividade → Mensagens e respostas aos stories → Controles de mensagens → Ferramentas conectadas → ligar **Permitir acesso às mensagens**. Sem isso, a Meta não entrega o Direct para as automações.

## 3. App da Meta: a pessoa faz no navegador, você guia

Abra https://developers.facebook.com/apps para ela, logada com o Facebook que administra a Página, e guie um item por vez. Os nomes dos menus mudam de vez em quando; se um rótulo não bater, procure pelo nome da permissão, do login ou de "Webhooks".

1. **Criar o app.** "Criar app" → nome livre (por exemplo, "Minhas automações") → caso de uso **Gerenciar mensagens e conteúdo no Instagram**. Se a Meta pedir um portfólio empresarial, pode vincular o da pessoa ou seguir sem.
2. **Escolher o login do Facebook.** No caso de uso, escolha a configuração da API **com login do Facebook** (não a do login do Instagram). Adicione as permissões `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging` e `business_management`.
   - Se `pages_messaging` não aparecer, adicione ao app também o caso de uso **Interagir com clientes no Messenger** (é nele que ela vem) e marque a permissão.
3. **Criar a configuração de login.** Em **Login do Facebook para Empresas → Configurações**, crie uma configuração com **token de acesso do usuário** (não escolha usuário do sistema), marque as oito permissões e salve. Anote o **ID da configuração** (só números).
4. **Endereço de retorno.** Na mesma área de configurações do login, em **URIs de redirecionamento do OAuth válidos**, cole o endereço de retorno do passo 1.7, igualzinho, e salve.
5. **Webhooks.** No caso de uso (etapa "Configurar webhooks") ou no menu **Webhooks**, escolha o objeto **Instagram**, cole a **URL de retorno de chamada** e o **token de verificação** do passo 1.7 e clique em **Verificar e salvar**. Depois assine os campos `messages`, `messaging_postbacks`, `messaging_seen`, `comments` e `live_comments`.
   - Se a Meta disser que não conseguiu verificar: rode `npm run configurar` de novo e confira se a URL e o token foram colados inteiros, sem espaço no fim.
   - `comments` e `live_comments` só chegam com o acesso avançado da Meta. Sem ele, as automações buscam os comentários sozinhas a cada minuto; nada a fazer.
6. **Dados básicos.** Em **Configurações do app → Básico**: anote o **ID do app** e a **Chave secreta do app** (clicar em "Mostrar" pede a senha do Facebook, que fica só com a pessoa); cole o endereço da política de privacidade do passo 1.7 em **URL da Política de Privacidade** e em **URL de instruções de exclusão de dados**; escolha uma categoria (por exemplo, "Negócios e páginas") e salve. Se pedir ícone, qualquer imagem quadrada serve. Se a pessoa já tem uma política de privacidade no site dela, pode usar a dela.
7. **Publicar o app.** No menu **Publicar** (ou no seletor **Modo do app** no topo: de Desenvolvimento para Ativo), publique. Sem isso a Meta não manda os eventos do Direct. Para usar no próprio perfil não é preciso análise do app.

Agora abra o `.env` para a pessoa preencher (Mac: `open -e .env`; Windows: `notepad .env`; Linux: `xdg-open .env`) nas linhas `META_APP_ID`, `META_APP_SECRET` e `META_CONFIG_ID`. Peça para salvar e avisar. Depois:

- `npm run configurar` confere o ID e a chave secreta com a própria Meta, guarda tudo no cofre do Supabase e apaga a chave secreta do `.env`. Precisa terminar com "O app da Meta foi conferido...".

## 4. Conectar o Instagram

1. `npm run conectar -- --instagram @perfil` (o @ do perfil profissional). Ele abre a tela oficial da Meta e espera até 90 segundos.
2. Na Meta, a pessoa entra com o Facebook que administra a Página, escolhe **a Página e o Instagram** e salva, aceitando todas as permissões. O pedido vale 30 minutos.
3. A janela mostra "Pronto! O Instagram @... está conectado às suas automações". O comando confirma sozinho; se o tempo acabar antes, rode `npm run status`.
4. `npm run conferir` precisa dizer "A Meta confirmou o acesso" e "A Página está inscrita".

Se a janela mostrar outra mensagem, ela já diz o que fazer. As mais comuns estão em "Se travar", no fim.

## 5. Testar com o perfil pessoal (modo teste)

O modo teste responde **só** às pessoas escolhidas (de 1 a 5), e elas precisam já ter falado com o perfil. Use o Instagram pessoal da pessoa (ou de alguém da equipe).

1. **Primeiro contato.** Peça para ela mandar "oi" do perfil pessoal para o Direct do perfil profissional. Em até 1 minuto, `npm run contatos` mostra o @ pessoal. Se não aparecer, veja "Se travar" (quase sempre é o passo 2.2, os webhooks do passo 3.5 ou o app não publicado no 3.7).
2. **Automação de Direct.** Copie `exemplos/direct-palavra.json` para `minhas-automacoes/guia.json` (a pasta `minhas-automacoes/` fica fora do Git). Pergunte à pessoa a palavra e o link que ela quer enviar e troque no arquivo (o `https://exemplo.com/...` é recusado de propósito). Depois:
   - `npm run salvar -- minhas-automacoes/guia.json` (anote o id de 8 caracteres);
   - `npm run testar -- <id> --pessoas @perfilpessoal`;
   - peça para ela mandar a palavra do perfil pessoal. A mensagem com o botão chega em segundos. `npm run conversa -- @perfilpessoal` mostra a troca.
3. **Automação de comentário.** `npm run posts` lista as publicações com o id. Pergunte em qual post testar, copie `exemplos/comentario-palavra-chave.json` para `minhas-automacoes/comentario.json`, coloque o id em `mediaId` e troque o link. Salve, teste com o mesmo `--pessoas` e peça para ela comentar a palavra do perfil pessoal. Em até 1 minuto chega o Direct com o botão; ao tocar, chega o link. A resposta pública aparece embaixo do comentário.
4. Se a pessoa não for usar já, `npm run pausar -- <id>` desliga cada teste.

## 6. Ativar para todos

Só com pedido da pessoa. Mostre numa mensagem o nome da automação, o gatilho, as palavras e o texto das mensagens, espere o "sim" e rode `npm run ativar -- <id>`. `npm run automacoes` mostra quantas pessoas entraram, quantas mensagens saíram e quantas clicaram no link.

## 7. O quadro

`npm run quadro` abre o quadro no navegador (endereço `http://127.0.0.1:4321`, só neste computador). Mostre as três abas à pessoa:

- **Automações:** nova automação a partir de modelos (comentário, próxima publicação, live, Direct, Story, menção), escolha do post pela miniatura, mensagens com botões, prévia, teste com pessoas escolhidas, ativar, desligar e lixeira.
- **Conversas:** quem falou com o perfil, a conversa inteira, responder (até 24 horas depois da última mensagem da pessoa), pausar a automação para uma pessoa e apagar os dados de quem pedir.
- **Conexão:** situação do Instagram, dos eventos e do agendador, "Conferir com a Meta" e "Processar agora".

O quadro fica no ar enquanto o terminal estiver aberto (Ctrl+C fecha). As automações continuam rodando no Supabase com o quadro fechado e o computador desligado.

## 8. Deixar pronto para o dia a dia

Para a pessoa poder pedir "cria uma automação para quem comentar QUERO no meu último Reels" de qualquer pasta, instale a skill no nível do usuário:

- **Claude Code:** copie `.claude/skills/automacoes-instagram/` para `~/.claude/skills/automacoes-instagram/`.
- **Codex:** copie `.agents/skills/automacoes-instagram/` para `~/.agents/skills/automacoes-instagram/`.
- Se a pasta das automações não for `~/automacoes-instagram`, troque o caminho na última linha do `SKILL.md` copiado.
- Se já existir uma skill com esse nome, mostre a diferença e pergunte antes de substituir.

Termine contando à pessoa, em até 3 linhas, o que ficou pronto e exemplos de pedidos:

- "Quem comentar EU QUERO no meu último Reels recebe este link no Direct."
- "Abre o quadro." / "Mostra as conversas de hoje."
- "Pausa a automação do guia." / "Responde a @fulano que amanhã eu mando."

## Se travar

| Mensagem ou sintoma | O que fazer |
|---|---|
| Falta preencher no arquivo .env | Rode de novo o passo indicado (1.2, 1.6 ou 3). |
| Use a chave secreta nova, que começa com sb_secret_ | Settings → API Keys → Secret keys, copie a `sb_secret_...` para `SUPABASE_SECRET_KEY`. |
| A Meta não reconheceu o ID do app com essa chave secreta | Confira os dois em Configurações do app → Básico e rode `npm run configurar`. |
| A Meta não conseguiu verificar a URL dos webhooks | `npm run configurar` primeiro (ele cria o token), depois cole a URL e o token de novo, inteiros. |
| A Meta aprovou, mas não mostrou nenhuma Página com Instagram | O Instagram precisa ser profissional e ligado a uma Página que a pessoa administra, e os dois precisam ser marcados na tela da Meta. Corrija e rode `npm run conectar -- --retomar`. |
| A Meta mostrou mais de um Instagram / mostrou outro | `npm run conectar -- --retomar --instagram @certo` (sem novo login). |
| Faltaram permissões na autorização | Confira as oito permissões na configuração do login (passo 3.3) e conecte de novo aceitando todas. |
| A Meta não confirmou a conexão (etapa: troca do código) | O endereço de retorno do passo 3.4 tem de ser idêntico ao do `npm run configurar`. Confira e conecte de novo. |
| A Página ainda não aceitou a inscrição dos eventos | Confira os webhooks (passo 3.5) e se o app está publicado (3.7). Depois `npm run conferir`. |
| O Direct de teste não aparece em `npm run contatos` | Na ordem: "Permitir acesso às mensagens" (2.2), campo `messages` assinado nos webhooks (3.5), app publicado (3.7) e `npm run conferir`. No painel do Supabase, Edge Functions → automacoes → Logs mostra cada "Webhook Instagram" que chegou. |
| O comentário de teste não gerou mensagem | Espere 1 minuto (os comentários são buscados a cada minuto) ou rode `npm run processar`. Confira se a automação está em teste com o @ certo e se o comentário tem a palavra. |
| JANELA_ENCERRADA | Passaram 24 horas da última mensagem da pessoa: o Instagram só deixa responder quando ela escrever de novo. |
| COMENTARIO_FORA_DO_PRAZO | A resposta privada a um comentário vale por 7 dias (na live, só enquanto ela está no ar). |
| LIMITE_DE_100_POR_HORA | Trava de segurança: no máximo 100 mensagens automáticas por hora por perfil. O resto sai depois. |
| META_REAUTORIZAR / "A Meta pediu nova autorização" | A chave do Instagram deixou de valer (senha trocada, app removido). `npm run conectar` de novo. |
| Erro de permissão ao responder comentários de pessoas de fora | Algumas regras da Meta pedem acesso avançado (análise do app e verificação da empresa) para responder comentários do público. Se acontecer, avise a pessoa: esse pedido é feito no painel da Meta e fica fora deste pacote. |

Para olhar por dentro: no painel do Supabase, **Edge Functions → automacoes → Logs** mostra cada webhook e cada rodada; **Integrations → Cron** mostra o agendador.

## Atualizar depois

Dentro da pasta: `git pull`, `npm test` e `npm run supabase:instalar`. A migração pode ser aplicada de novo sem apagar nada, e a função é republicada. Para desfazer tudo do lado da Meta: no Facebook, em **Integrações comerciais**, remova o app; aqui, `npm run desconectar -- --sim`.
