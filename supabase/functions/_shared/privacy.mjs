// Texto da política de privacidade servido pela própria função (o app da Meta precisa de um endereço público para ela).
export function privacyText(who) {
  return [
    `Política de privacidade das respostas automáticas no Instagram (${who})`,
    '',
    'O que este serviço faz: responde a comentários, mensagens no Direct, respostas e menções em Stories do perfil, pela API oficial '
      + 'da Meta, e permite que a equipe do perfil continue a conversa.',
    '',
    'O que fica guardado: o identificador da conversa que o Instagram fornece, o nome de usuário e o nome público, o texto das mensagens '
      + 'e dos comentários trocados com o perfil e os cliques nos links enviados. Senhas nunca são pedidas nem guardadas.',
    '',
    'Onde fica: no banco de dados do próprio dono do perfil. Os dados só circulam entre o Instagram (Meta) e esse banco e não são '
      + 'vendidos nem repassados.',
    '',
    'Por quanto tempo: as conversas ficam enquanto forem úteis para o atendimento; os registros técnicos de recebimento são apagados em 30 dias.',
    '',
    `Como pedir a exclusão dos seus dados: mande uma mensagem no Direct de ${who} pedindo a exclusão. A conversa e os dados ligados `
      + 'a ela são apagados.',
  ].join('\n');
}
