// Testa o achado 8 da auditoria: chamada repetida com o mesmo requestId (retry do navegador
// após um timeout aparente) não reprocessa do zero — devolve a resposta já gravada, ou avisa
// que já está em processamento se ainda não terminou.
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) {
  return {
    id: c.split('/').pop(), path: c,
    async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados, opts) { banco.set(c, opts && opts.merge ? { ...(banco.get(c) || {}), ...dados } : dados); },
    async create(dados) {
      if (banco.has(c)) { const e = new Error('ALREADY_EXISTS: ' + c); e.code = 6; throw e; }
      banco.set(c, dados);
    },
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
let chamadasIA = 0;
class FakeAnthropic {
  constructor() { this.messages = { create: async (params) => { chamadasIA++; const p = roteiro.shift(); if (!p) throw new Error('roteiro acabou'); return typeof p === 'function' ? p(params) : p; } }; }
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

(async () => {
  console.log('1) chamada normal com requestId — processa e grava o requestId na mensagem');
  prepararEmpresa();
  roteiro = [resp([txt('Oi, tudo certo.')], 'end_turn')];
  let r = await pedido('oi', 'req-abc-1');
  confere('respondeu normal', r.text === 'Oi, tudo certo.', r.text);
  confere('IA foi chamada 1 vez', chamadasIA === 1);
  const msgs = [...banco.entries()].filter(([k]) => k.includes('/mensagens/'));
  confere('mensagem gravada com o requestId', msgs.some(([, v]) => v.requestId === 'req-abc-1'));

  console.log('\n2) retry com o MESMO requestId depois que a 1a já terminou — devolve sem rechamar a IA');
  const r2 = await pedido('oi', 'req-abc-1');
  confere('devolve a mesma resposta', r2.text === 'Oi, tudo certo.', r2.text);
  confere('IA NÃO foi chamada de novo', chamadasIA === 1, chamadasIA);

  console.log('\n3) requestId diferente processa normalmente (não é bloqueado por engano)');
  roteiro = [resp([txt('Outra pergunta, outra resposta.')], 'end_turn')];
  const r3 = await pedido('outra coisa', 'req-abc-2');
  confere('processou de novo com requestId novo', r3.text === 'Outra pergunta, outra resposta.', r3.text);
  confere('IA foi chamada de novo (2a vez no total)', chamadasIA === 2, chamadasIA);

  console.log('\n4) duas chamadas concorrentes com o MESMO requestId (nenhuma delas terminou ainda)');
  prepararEmpresa();
  let liberar;
  const travaManual = new Promise((res) => { liberar = res; });
  roteiro = [
    async () => { await travaManual; return resp([txt('Terminei.')], 'end_turn'); }, // 1a chamada: fica "pendurada" até eu liberar
  ];
  const p1 = pedido('gera algo demorado', 'req-concorrente');
  await new Promise((r) => setTimeout(r, 20)); // dá tempo da 1a chamada criar a trava antes da 2a tentar
  let erro2 = null;
  try { await pedido('gera algo demorado', 'req-concorrente'); } catch (e) { erro2 = e; }
  confere('2a chamada concorrente recebe already-exists (não reprocessa em paralelo)', erro2 && erro2.code === 'already-exists', erro2 && erro2.message);
  liberar();
  const r1final = await p1;
  confere('1a chamada termina normalmente', r1final.text === 'Terminei.', r1final.text);

  console.log('\n5) sem requestId nenhum, continua funcionando como sempre (sem trava)');
  prepararEmpresa();
  roteiro = [resp([txt('Sem requestId, de boa.')], 'end_turn'), resp([txt('De novo, sem trava nenhuma.')], 'end_turn')];
  const r5a = await pedido('oi');
  const r5b = await pedido('oi de novo');
  confere('duas chamadas sem requestId processam as duas', r5a.text === 'Sem requestId, de boa.' && r5b.text === 'De novo, sem trava nenhuma.');

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
