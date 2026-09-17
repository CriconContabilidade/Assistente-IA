// Testa o item 2 da Fase 3: padrões de lançamento como dado estruturado, casamento
// determinístico, e detecção de conflito na hora de salvar (o problema real que apareceu no
// Holding/Althoff na Fase 1 — duas regras contraditórias pra mesma chave — não pode mais
// acontecer sem ninguém perceber).
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) {
  return {
    id: c.split('/').pop(), path: c,
    async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados, opts) { banco.set(c, opts && opts.merge ? { ...(banco.get(c) || {}), ...dados } : dados); },
    async create(dados) { if (banco.has(c)) { const e = new Error('exists'); e.code = 6; throw e; } banco.set(c, dados); },
    collection: (n) => colRef(`${c}/${n}`),
  };
}
let seq = 0;
function colRef(c) {
  const q = {
    orderBy: () => q, limit: () => q, where: () => q,
    get: async () => {
      const docs = [...banco.keys()].filter((k) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/'))
        .map((k) => ({ id: k.split('/').pop(), data: () => banco.get(k), ref: docRef(k) }));
      return { docs, empty: docs.length === 0 };
    },
  };
  return { ...q, doc: (id) => docRef(`${c}/${id || 'auto' + (++seq)}`), async add(dados) { const r = docRef(`${c}/auto${++seq}`); await r.set(dados); return r; } };
}
const fakeDb = { collection: (n) => colRef(n) };

let roteiro = [];
class FakeAnthropic {
  constructor() { this.messages = { create: async (params) => { const p = roteiro.shift(); if (!p) throw new Error('roteiro acabou'); return typeof p === 'function' ? p(params) : p; } }; }
}
const txt = (t) => ({ type: 'text', text: t });
let idSeq = 0;
const uso = (name, input) => ({ type: 'tool_use', id: `toolu_${++idSeq}`, name, input });
const resp = (content, stop_reason) => ({ content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } });

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (o, f) => f, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'x' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'T', arrayUnion: (...x) => ({ __union: x }) } },
  'firebase-admin/auth': { getAuth: () => ({}) },
  '@anthropic-ai/sdk': FakeAnthropic,
  exceljs: {},
  'firebase/app': { initializeApp: () => ({}) },
  'firebase/auth': { getAuth: () => ({}), signInAnonymously: async () => ({}) },
  'firebase/firestore': { getFirestore: () => ({}), doc: () => ({}), collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}), getDoc: async () => ({ exists: () => false, data: () => ({}) }), getDocs: async () => ({ empty: true, docs: [] }) },
};
const orig = Module._load;
Module._load = function (req, p, m) { return req in falsos ? falsos[req] : orig.apply(this, arguments); };
const handler = require(ARQ).assistenteChat;

let falhas = 0;
function confere(nome, ok, detalhe = '') { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); }
function prepararEmpresa() {
  banco.clear();
  banco.set('assistenteIA_empresas/mv', { nome: 'MV', notas: [], responsavelEmail: '', codigoDominio: '185', cnpj: '21208224000163' });
}
const pedido = (message) => handler({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: { empresaId: 'mv', message, history: [], files: [] } });
const padroesSalvos = () => [...banco.entries()].filter(([k]) => k.includes('/padroes/')).map(([, v]) => v);

(async () => {
  console.log('1) consultar sem nada salvo -> "nenhum"');
  prepararEmpresa();
  roteiro = [
    resp([uso('consultar_padrao', { descricao: 'TARIFA COBRANCA', valor: 12 })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('responde "nenhum padrão"', r.content.includes('Nenhum padrão') && !r.is_error, r.content);
      return resp([txt('Primeira vez, vou perguntar.')], 'end_turn');
    },
  ];
  await pedido('processa extrato');

  console.log('\n2) salvar um padrão novo');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['TARIFA'], debito: '384', credito: '7', historico: 'PAGAMENTO REF. TARIFA {mes}/{ano}' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('salvou sem erro', !r.is_error, r.content);
      return resp([txt('Salvo.')], 'end_turn');
    },
  ];
  await pedido('salva o padrão de tarifa');
  confere('1 padrão gravado no Firestore', padroesSalvos().length === 1, padroesSalvos());

  console.log('\n3) consultar de novo, mesma descrição -> "encontrado"');
  roteiro = [
    resp([uso('consultar_padrao', { descricao: 'TARIFA COBRANCA BANCO', valor: 8 })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('encontra o padrão salvo', r.content.includes('Débito 384 / Crédito 7'), r.content);
      return resp([txt('Achou.')], 'end_turn');
    },
  ];
  await pedido('de novo');

  console.log('\n4) descrição diferente -> "nenhum" de novo (não confunde padrão)');
  roteiro = [
    resp([uso('consultar_padrao', { descricao: 'PIX RECEBIDO FULANO' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('não confunde com o padrão de tarifa', r.content.includes('Nenhum padrão'), r.content);
      return resp([txt('Nada.')], 'end_turn');
    },
  ];
  await pedido('outro lançamento');

  console.log('\n5) salvar padrão CONTRADITÓRIO pra mesma chave -> recusa (achado do Holding/Althoff, agora bloqueado)');
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['TARIFA'], ignorar: true })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('recusa com is_error e explica o conflito', r.is_error && r.content.includes('tratamento diferente'), r.content);
      return resp([txt('Vou perguntar ao usuário.')], 'end_turn');
    },
  ];
  await pedido('tarifa agora é pra ignorar');
  confere('continua só 1 padrão salvo (não corrompeu)', padroesSalvos().length === 1);

  console.log('\n6) mesma chave, mas com condicaoValor diferenciando -> salva sem conflito');
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['RECEBIMENTO PIX'], condicaoValor: 200, debito: '10', credito: '58', historico: 'ALUGUEL SALAO' })], 'tool_use'),
    resp([uso('salvar_padrao', { palavrasChave: ['RECEBIMENTO PIX'], condicaoValor: 60, debito: '10', credito: '64', historico: 'ALUGUEL QUIOSQUE' })], 'tool_use'),
    resp([txt('Os dois salvos.')], 'end_turn'),
  ];
  const r6 = await pedido('dois padrões com o mesmo texto, valores diferentes');
  confere('não deu erro em nenhuma resposta', r6.text === 'Os dois salvos.', r6.text);
  confere('2 padrões novos gravados (+ o de tarifa = 3)', padroesSalvos().length === 3, padroesSalvos().length);

  console.log('\n7) consultar com o valor certo escolhe o padrão certo entre os dois condicionados');
  roteiro = [
    resp([uso('consultar_padrao', { descricao: 'RECEBIMENTO PIX 123', valor: 200 })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('valor=200 acha o padrão do salão', r.content.includes('ALUGUEL SALAO'), r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere o de 200');

  console.log('\n8) padrão migrado incompleto (pendenteRevisao) -> avisa, e completar não gera conflito');
  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/padroes/migrado1', {
    palavrasChave: ['PENSAO ALIMENTICIA'], ehRegex: false, condicaoValor: null, ignorar: false,
    debito: null, credito: null, codigoHistorico: null, historico: null, periodo: null, pendenteRevisao: true,
  });
  roteiro = [
    resp([uso('consultar_padrao', { descricao: 'PENSAO ALIMENTICIA JOAO' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('avisa que está incompleto, não trata como "nenhum"', r.content.includes('incompleto'), r.content);
      return resp([uso('salvar_padrao', { palavrasChave: ['PENSAO ALIMENTICIA'], debito: '237', credito: '10', historico: 'PAGAMENTO REF. PENSAO ALIMENTICIA - JOAO' })], 'tool_use');
    },
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('completar o pendente NÃO gera conflito', !r.is_error, r.content);
      return resp([txt('Completo.')], 'end_turn');
    },
  ];
  await pedido('pensao');
  const salvos8 = padroesSalvos();
  confere('continua só 1 documento pra essa chave (atualizou, não duplicou)', salvos8.filter(p => p.palavrasChave.includes('PENSAO ALIMENTICIA')).length === 1, salvos8.length);
  confere('não está mais pendente', salvos8.find(p => p.palavrasChave.includes('PENSAO ALIMENTICIA')).pendenteRevisao === false);

  console.log('\n9) padrão com provisão (segundo lançamento em conjunto)');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', {
      palavrasChave: ['DISTRIBUICAO LUCROS'], debito: '241', credito: '10', historico: 'PAGAMENTO REF. DISTRIBUICAO DE LUCROS',
      provisao: { debito: '99', credito: '241', historico: 'PROVISAO REF. DISTRIBUICAO DE LUCROS' },
    })], 'tool_use'),
    resp([uso('consultar_padrao', { descricao: 'DISTRIBUICAO LUCROS SOCIO' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('avisa da provisão junto do padrão principal', r.content.includes('TAMBÉM gere um segundo lançamento de provisão') && r.content.includes('PROVISAO REF'), r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('distribuição de lucros');

  console.log('\n10) padrão CONTRADITÓRIO com condicaoValor também é bloqueado (achado do Codex)');
  // Antes, salvar com condicaoValor pulava a checagem de conflito por completo — dava pra
  // salvar duas regras diferentes pra mesma chave+valor sem aviso nenhum.
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['ALUGUEL LOJA'], condicaoValor: 500, debito: '10', credito: '58' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('primeiro salva sem erro', !r.is_error, r.content);
      return resp([uso('salvar_padrao', { palavrasChave: ['ALUGUEL LOJA'], condicaoValor: 500, ignorar: true })], 'tool_use');
    },
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('mesma chave + mesmo valor com tratamento diferente -> recusa', r.is_error && r.content.includes('tratamento diferente'), r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('aluguel condicionado, depois contraditório');
  confere('continua só 1 padrão salvo pra essa chave', padroesSalvos().filter(p => p.palavrasChave.includes('ALUGUEL LOJA')).length === 1);

  console.log('\n11) mesma chave com acento/maiúscula diferente é reconhecida como conflito (achado do Codex)');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['Sódio'], debito: '10', credito: '58' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('primeiro salva sem erro', !r.is_error, r.content);
      return resp([uso('salvar_padrao', { palavrasChave: ['SODIO'], ignorar: true })], 'tool_use');
    },
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('"SODIO" sem acento é reconhecida como a mesma chave de "Sódio" -> recusa', r.is_error && r.content.includes('tratamento diferente'), r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('sodio com e sem acento');

  console.log('\n12) mesmo débito/crédito mas histórico diferente NÃO é "mesmo tratamento" (achado do Codex)');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['MANUTENCAO'], debito: '10', credito: '58', historico: 'MANUTENCAO PREDIAL' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('primeiro salva sem erro', !r.is_error, r.content);
      return resp([uso('salvar_padrao', { palavrasChave: ['MANUTENCAO'], debito: '10', credito: '58', historico: 'MANUTENCAO DE VEICULO' })], 'tool_use');
    },
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('mesmo débito/crédito mas histórico diferente -> recusa (antes passava despercebido)', r.is_error && r.content.includes('tratamento diferente'), r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('manutencao com historicos diferentes');
  confere('continua só 1 padrão salvo pra essa chave', padroesSalvos().filter(p => p.palavrasChave.includes('MANUTENCAO')).length === 1);

  console.log('\n13) salvar o MESMO padrão de novo não duplica (achado do Codex)');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_padrao', { palavrasChave: ['ENERGIA'], debito: '10', credito: '58', historico: 'CONTA DE LUZ' })], 'tool_use'),
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('primeiro salva sem erro', !r.is_error, r.content);
      return resp([uso('salvar_padrao', { palavrasChave: ['ENERGIA'], debito: '10', credito: '58', historico: 'CONTA DE LUZ' })], 'tool_use');
    },
    (params) => {
      const r = params.messages[params.messages.length - 1].content[0];
      confere('salvar de novo, idêntico, não dá erro', !r.is_error, r.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('energia salva duas vezes igual');
  confere('não duplicou — continua só 1 documento pra essa chave', padroesSalvos().filter(p => p.palavrasChave.includes('ENERGIA')).length === 1, padroesSalvos().length);

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
