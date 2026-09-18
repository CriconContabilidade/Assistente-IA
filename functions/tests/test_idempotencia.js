// Testa a idempotência (item 8 da auditoria original + correções apontadas pelo Codex):
// - o resultado fica no documento de processamento, não é mais buscado por query em
//   "mensagens" sem filtro de role (achado: podia devolver a própria pergunta do usuário
//   como se fosse a resposta da IA — reproduzido explicitamente no cenário 2 abaixo);
// - erro na primeira tentativa marca "failed" e libera o requestId pra tentar de novo, em vez
//   de travar pra sempre (achado do Codex);
// - concorrência real (duas chamadas, nenhuma terminou) continua recusando a segunda.
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) {
  return {
    id: c.split('/').pop(), path: c,
    async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados, opts) { banco.set(c, opts && opts.merge ? { ...(banco.get(c) || {}), ...dados } : dados); },
    async create(dados) { if (banco.has(c)) { const e = new Error('ALREADY_EXISTS: ' + c); e.code = 6; throw e; } banco.set(c, dados); },
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
// Transação simplificada (síncrona por baixo, só pra refletir o fluxo lógico — não testa
// isolamento real de concorrência entre processos, que não existe em JS single-threaded).
const fakeDb = {
  collection: (n) => colRef(n),
  async runTransaction(fn) {
    const tx = {
      async get(ref) { return ref.get(); },
      set(ref, dados, opts) { banco.set(ref.path, opts && opts.merge ? { ...(banco.get(ref.path) || {}), ...dados } : dados); },
    };
    return fn(tx);
  },
};

let roteiro = [];
let chamadasIA = 0;
class FakeAnthropic {
  constructor() {
    const create = async (params) => { chamadasIA++; const p = roteiro.shift(); if (!p) throw new Error('roteiro acabou'); return typeof p === 'function' ? p(params) : p; };
    this.messages = { create, stream: (params) => ({ finalMessage: () => create(params) }) };
  }
}
const txt = (t) => ({ type: 'text', text: t });
const resp = (content, stop_reason) => ({ content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } });

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (o, f) => f, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'x' }) },
  'firebase-admin/app': { initializeApp() {} },
  // serverTimestamp precisa se comportar como um Timestamp real (com toMillis()) — é assim que
  // o código de produção mede se o lease de um processamento "running" já expirou.
  'firebase-admin/firestore': { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => ({ toMillis: () => Date.now() }), arrayUnion: (...x) => ({ __union: x }) } },
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
  chamadasIA = 0;
}
const pedido = (message, requestId) => handler({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: { empresaId: 'mv', message, history: [], files: [], requestId } });
const processamento = (id) => banco.get(`assistenteIA_empresas/mv/processamentos/${id}`);

(async () => {
  console.log('1) chamada normal com requestId — processa e marca "completed"');
  prepararEmpresa();
  roteiro = [resp([txt('Oi, tudo certo.')], 'end_turn')];
  let r = await pedido('oi', 'req-1');
  confere('respondeu normal', r.text === 'Oi, tudo certo.', r.text);
  confere('IA foi chamada 1 vez', chamadasIA === 1);
  confere('processamento marcado completed com o texto certo', processamento('req-1').status === 'completed' && processamento('req-1').text === 'Oi, tudo certo.', processamento('req-1'));

  console.log('\n2) retry NUNCA devolve a mensagem do USUÁRIO como se fosse da IA (achado do Codex)');
  // reproduz o cenário real: a mensagem de usuário grava o MESMO requestId no Firestore (é
  // assim que o app funciona) — a query antiga (sem filtrar role) podia achar essa em vez do
  // resultado de verdade. Agora nem existe mais query nenhuma em "mensagens" para isso.
  banco.set('assistenteIA_empresas/mv/mensagens/msgUsuario', { role: 'user', text: 'oi', requestId: 'req-1' });
  const r2 = await pedido('oi', 'req-1');
  confere('devolve a resposta da IA, NÃO a pergunta do usuário', r2.text === 'Oi, tudo certo.', r2.text);
  confere('IA NÃO foi chamada de novo', chamadasIA === 1, chamadasIA);

  console.log('\n3) requestId diferente processa normalmente');
  roteiro = [resp([txt('Outra pergunta, outra resposta.')], 'end_turn')];
  const r3 = await pedido('outra coisa', 'req-2');
  confere('processou de novo com requestId novo', r3.text === 'Outra pergunta, outra resposta.', r3.text);
  confere('IA foi chamada de novo (2a vez no total)', chamadasIA === 2, chamadasIA);

  console.log('\n4) duas chamadas concorrentes com o MESMO requestId (nenhuma terminou ainda)');
  prepararEmpresa();
  let liberar;
  const travaManual = new Promise((res) => { liberar = res; });
  roteiro = [async () => { await travaManual; return resp([txt('Terminei.')], 'end_turn'); }];
  const p1 = pedido('gera algo demorado', 'req-concorrente');
  await new Promise((r) => setTimeout(r, 20));
  let erro2 = null;
  try { await pedido('gera algo demorado', 'req-concorrente'); } catch (e) { erro2 = e; }
  confere('2a chamada concorrente recebe already-exists', erro2 && erro2.code === 'already-exists', erro2 && erro2.message);
  liberar();
  const r1final = await p1;
  confere('1a chamada termina normalmente', r1final.text === 'Terminei.', r1final.text);

  console.log('\n4b) fencing: tentativa antiga não sobrescreve quem já reassumiu o lease (achado do Codex)');
  // Simula o caso em que o navegador desistiu (timeout de 280s) e tentou de novo bem na hora
  // em que o lease "parece" ter expirado, mas a tentativa original ainda está processando de
  // verdade (não travou, só está demorando) — as duas continuam até o fim, e SEM fencing a
  // que terminasse por último sobrescrevia o resultado da outra no documento compartilhado.
  prepararEmpresa();
  let liberarLenta;
  const travaLenta = new Promise((res) => { liberarLenta = res; });
  roteiro = [
    async () => { await travaLenta; return resp([txt('Terminei devagar.')], 'end_turn'); },
    resp([txt('Terminei rápido.')], 'end_turn'),
  ];
  const pLenta = pedido('primeira tentativa, vai demorar', 'req-fence');
  await new Promise((r) => setTimeout(r, 20)); // deixa a 1a reservar e pendurar em travaLenta

  // "passa o tempo": marca o lease da 1a tentativa como expirado, simulando os 280s+ que
  // fariam o navegador desistir e tentar de novo — sem de fato esperar 280s no teste.
  const docProc = processamento('req-fence');
  banco.set('assistenteIA_empresas/mv/processamentos/req-fence', {
    ...docProc,
    iniciadoEm: { toMillis: () => Date.now() - 400 * 1000 },
  });

  const rRapida = await pedido('segunda tentativa, reassume o lease', 'req-fence');
  confere('2a tentativa reassume e termina normal', rRapida.text === 'Terminei rápido.', rRapida.text);
  const attemptIdDepoisDaRapida = processamento('req-fence').attemptId;

  liberarLenta();
  const rLentaFinal = await pLenta;
  confere('1a tentativa (antiga) ainda recebe a PRÓPRIA resposta, não erro', rLentaFinal.text === 'Terminei devagar.', rLentaFinal.text);
  confere('documento compartilhado continua com o resultado da 2a tentativa (não foi sobrescrito)',
    processamento('req-fence').text === 'Terminei rápido.', processamento('req-fence'));
  confere('attemptId no documento não voltou a mudar', processamento('req-fence').attemptId === attemptIdDepoisDaRapida);
  const mensagensDoFence = [...banco.entries()].filter(([k]) => k.startsWith('assistenteIA_empresas/mv/mensagens/') && k.includes('req-fence'));
  confere('só existe UMA mensagem do assistente pra essa troca (não duplicou na tela)', mensagensDoFence.length === 1, mensagensDoFence.map(([k]) => k));
  confere('a mensagem gravada é a da tentativa que ganhou (rápida), não a que perdeu (lenta)',
    mensagensDoFence[0] && mensagensDoFence[0][1].text === 'Terminei rápido.', mensagensDoFence[0] && mensagensDoFence[0][1]);

  console.log('\n5) erro na 1a tentativa marca "failed" e NÃO trava o requestId pra sempre (achado do Codex)');
  prepararEmpresa();
  roteiro = [() => { throw new Error('Anthropic fora do ar'); }];
  let erroPrimeira = null;
  try { await pedido('oi', 'req-com-erro'); } catch (e) { erroPrimeira = e; }
  confere('primeira tentativa realmente falhou', !!erroPrimeira);
  confere('processamento marcado "failed"', processamento('req-com-erro').status === 'failed', processamento('req-com-erro'));
  roteiro = [resp([txt('Segunda tentativa deu certo.')], 'end_turn')];
  const r5 = await pedido('oi', 'req-com-erro');
  confere('MESMO requestId consegue reprocessar depois do erro', r5.text === 'Segunda tentativa deu certo.', r5.text);

  console.log('\n6) processamento "running" com lease expirado é reassumido (function caiu no meio)');
  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/processamentos/req-travado', { status: 'running', iniciadoEm: { toMillis: () => Date.now() - 400 * 1000 } });
  roteiro = [resp([txt('Reassumiu depois do lease expirar.')], 'end_turn')];
  const r6 = await pedido('oi', 'req-travado');
  confere('reassume um processamento "running" com lease vencido', r6.text === 'Reassumiu depois do lease expirar.', r6.text);

  console.log('\n7) sem requestId nenhum, continua funcionando como sempre (sem trava)');
  prepararEmpresa();
  roteiro = [resp([txt('Sem requestId, de boa.')], 'end_turn'), resp([txt('De novo, sem trava nenhuma.')], 'end_turn')];
  const r7a = await pedido('oi');
  const r7b = await pedido('oi de novo');
  confere('duas chamadas sem requestId processam as duas', r7a.text === 'Sem requestId, de boa.' && r7b.text === 'De novo, sem trava nenhuma.');

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
