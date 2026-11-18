import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { compileFlow } from '../supabase/functions/_shared/flows.mjs';

const ROOT = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, ROOT), 'utf8');
const SKILL = '.claude/skills/automacoes-instagram/SKILL.md';

test('a skill é a mesma no Claude Code e no Codex', () => {
  assert.equal(read('.agents/skills/automacoes-instagram/SKILL.md'), read(SKILL));
});

test('todo "npm run" citado nos roteiros existe no package.json', () => {
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts);
  for (const file of ['README.md', 'INSTALAR.md', 'AGENTS.md', SKILL]) {
    for (const [, name] of read(file).matchAll(/npm run (?:--silent )?([a-z:-]+)/g)) {
      assert.ok(scripts.includes(name), `${file} cita "npm run ${name}", que não existe`);
    }
  }
});

test('a versão da CLI do Supabase citada no roteiro é a mesma do código', async () => {
  const { SUPABASE_CLI } = await import('../src/setup.mjs');
  for (const [version] of read('INSTALAR.md').matchAll(/supabase@[0-9.]+/g)) assert.equal(version, SUPABASE_CLI);
});

test('os exemplos são automações válidas depois de trocar o link e o post', () => {
  const files = fs.readdirSync(new URL('exemplos/', ROOT)).filter(file => file.endsWith('.json'));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const text = read(`exemplos/${file}`).replaceAll('https://exemplo.com/troque-este-link', 'https://consultorio.test/material')
      .replace('"mediaId": ""', '"mediaId": "18000000000000001"');
    assert.doesNotThrow(() => compileFlow(JSON.parse(text)), file);
  }
});

test('o repositório não leva chaves, e-mails nem endereços de projetos reais', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(file => file && !/\.(png|jpg|jpeg|webp|mp4)$/i.test(file) && fs.existsSync(new URL(file, ROOT)));
  const forbidden = [
    [/sb_secret_(?!chave_de_teste)[A-Za-z0-9_-]{16,}/, 'chave secreta do Supabase'],
    [/eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/, 'token JWT'],
    [/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+\.(com|br|org|net)\b/, 'e-mail'],
    [/https:\/\/(?!abcdefghijklmnopqrst\.)[a-z]{20}\.supabase\.co/, 'endereço de um projeto real do Supabase'],
  ];
  for (const file of files) {
    const text = read(file);
    for (const [pattern, label] of forbidden) assert.ok(!pattern.test(text), `${file} contém ${label}`);
  }
});
