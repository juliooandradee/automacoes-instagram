import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFlow, flowPriority, matchesFlow, nextIndex, sharesEntryPoint } from '../supabase/functions/_shared/flows.mjs';
import { normalizeWebhook, polledCommentEvent } from '../supabase/functions/_shared/events.mjs';
import { cleanDraft } from '../supabase/functions/_shared/panel.mjs';

const base = {
  name: 'Teste', trigger: 'comment', media: 'specific', mediaId: '18000000000000001', match: 'contains', keywords: 'guia', publicReplies: [],
  blocks: [{ id: 'b1', text: 'Quer o guia?', buttons: [{ id: 'sim', type: 'reply', title: 'LIBERAR', target: 'b2' }] },
    { id: 'b2', text: 'Aqui está', buttons: [{ id: 'abrir', type: 'link', title: 'Abrir', url: 'https://consultorio.test/guia' }] }],
};
const flow = extra => ({ ...structuredClone(base), ...extra });

test('compila o fluxo na ordem de execução e com o caminho de cada botão', () => {
  const compiled = compileFlow(flow());
  assert.deepEqual(compiled.nodes.map(node => node.id), ['b1', 'b2']);
  assert.equal(nextIndex(compiled.nodes, 0, 'sim'), 1);
  assert.equal(nextIndex(compiled.nodes, 1), 2, 'fim do fluxo');
});

test('recusa fluxos que a Meta ou a lógica não aceitam', () => {
  const cases = [
    [{ blocks: [{ id: 'b1', text: 'Oi', next: 'b2' }, { id: 'b2', text: 'Link', next: null }] }, /botão de resposta na primeira mensagem/],
    [{ blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'a', type: 'reply', title: 'SIM', target: 'b1' }, { id: 'l', type: 'link', title: 'Abrir', url: 'https://x.com' }] }] }, /links na mensagem seguinte/],
    [{ blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'a', type: 'reply', title: 'SIM', target: 'b2' }] }, { id: 'b2', text: 'De novo', buttons: [{ id: 'v', type: 'reply', title: 'VOLTAR', target: 'b1' }] }] }, /ciclo/],
    [{ blocks: [{ id: 'b1', text: 'Oi' }, { id: 'b2', text: 'Solta' }] }, /Ligue todas as mensagens/],
    [{ blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'l', type: 'link', title: 'Abrir', url: 'http://inseguro.com' }] }] }, /HTTPS/],
    [{ blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'l', type: 'link', title: 'Um título comprido demais aqui', url: 'https://x.com' }] }] }, /20 caracteres/],
    [{ match: 'contains', keywords: ' , ' }, /ao menos uma palavra/],
    [{ media: 'specific', mediaId: '' }, /miniatura/],
    [{ blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'l', type: 'link', title: 'Abrir', url: 'https://www.exemplo.com/material' }] }], trigger: 'direct', media: 'all' }, /link de exemplo/],
    [{ trigger: 'direct', media: 'all', blocks: [{ id: 'b1', text: '' }] }, /vazia/],
  ];
  for (const [extra, message] of cases) assert.throws(() => compileFlow(flow(extra)), message, JSON.stringify(extra));
});

test('casa por palavra sem acento e maiúscula, com prioridade para publicação específica e palavra exata', () => {
  const specific = flow();
  const anyLive = flow({ media: 'live', mediaId: null });
  assert.ok(matchesFlow(specific, { kind: 'comment', text: 'Quero o GUÍA', mediaId: '18000000000000001' }));
  assert.ok(!matchesFlow(specific, { kind: 'comment', text: 'quero o guia', mediaId: '18000000000000002' }));
  assert.ok(!matchesFlow(specific, { kind: 'comment', text: 'quero o guia', mediaId: '18000000000000001', live: true }));
  assert.ok(matchesFlow(anyLive, { kind: 'comment', text: 'guia', mediaId: '1', live: true }));
  assert.ok(!matchesFlow(flow({ media: 'next' }), { kind: 'comment', text: 'guia', mediaId: '18000000000000001' }));
  const exact = { ...flow({ trigger: 'direct', media: 'all' }), match: 'exact', keywords: 'agenda' };
  assert.ok(matchesFlow(exact, { kind: 'direct', text: ' Agenda ' }));
  assert.ok(!matchesFlow(exact, { kind: 'direct', text: 'qual a agenda' }));
  assert.ok(flowPriority(specific, 'guia') > flowPriority(anyLive, 'guia'));
});

test('duas automações no mesmo ponto de entrada com palavras que se cruzam entram em conflito', () => {
  assert.ok(sharesEntryPoint(flow(), flow({ keywords: 'quero o guia' })));
  assert.ok(!sharesEntryPoint(flow(), flow({ keywords: 'agenda' })));
  assert.ok(!sharesEntryPoint(flow(), flow({ mediaId: '18000000000000002' })));
  assert.ok(sharesEntryPoint(flow({ trigger: 'story_reply', media: 'all', match: 'any' }), flow({ trigger: 'story_reply', media: 'specific', mediaId: '18000000000000003', match: 'any' })));
});

test('lê Direct, Story, menção, botão, eco e comentário de live do webhook', async () => {
  const at = Date.now();
  const events = await normalizeWebhook({ object: 'instagram', entry: [{ id: '17841400000000001', time: at,
    changes: [{ field: 'comments', value: { id: '17900000000000001', text: 'eu quero', from: { id: '700100', username: 'Pessoa' }, media: { id: '18000000000000001' } } },
      { field: 'live_comments', value: { id: '17900000000000001', text: 'eu quero', from: { id: '700100', username: 'Pessoa' }, media: { id: '18000000000000001' } } }],
    messaging: [
      { sender: { id: '700200' }, recipient: { id: '17841400000000001' }, timestamp: at, message: { mid: 'm1', text: 'oi' } },
      { sender: { id: '700200' }, recipient: { id: '17841400000000001' }, timestamp: at, message: { mid: 'm2', text: 'lindo', reply_to: { story: { id: '18000000000000777', url: 'https://cdn' } } } },
      { sender: { id: '700200' }, recipient: { id: '17841400000000001' }, timestamp: at, message: { mid: 'm3', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn' } }] } },
      { sender: { id: '700200' }, recipient: { id: '17841400000000001' }, timestamp: at, postback: { mid: 'm4', title: 'SIM', payload: 'ig:abc:sim' } },
      { sender: { id: '17841400000000001' }, recipient: { id: '700200' }, timestamp: at, message: { mid: 'm5', text: 'resposta', is_echo: true } },
    ] }] });
  assert.deepEqual(events.map(event => event.kind), ['comment', 'direct', 'story_reply', 'story_mention', 'postback', 'echo']);
  assert.equal(events[0].live, true);
  assert.equal(events[0].key, 'live:17900000000000001');
  assert.equal(events[2].mediaId, '18000000000000777');
  assert.equal(events[4].buttonPayload, 'ig:abc:sim');
  assert.equal(events[5].scopedId, '700200');
  assert.equal(polledCommentEvent('17841400000000001', '1', { id: '2', fromId: '17841400000000001', text: 'meu', timestamp: 'x' }), null, 'comentário da própria conta é ignorado');
});

test('o quadro só guarda os campos conhecidos', () => {
  const clean = cleanDraft({ ...flow(), extra: 'nada', blocks: [{ id: 'b1', text: 'Oi', buttons: [{ id: 'x', type: 'link', title: 'Abrir', url: 'https://x.com', target: 'b2' }], hack: 1 }] });
  assert.equal(clean.extra, undefined);
  assert.equal(clean.blocks[0].hack, undefined);
  assert.equal(clean.blocks[0].buttons[0].target, undefined, 'botão de link não tem destino');
  assert.throws(() => cleanDraft({ name: ' ' }), /nome/);
});
