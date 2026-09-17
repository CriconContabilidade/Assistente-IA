// Testa o achado 7 da auditoria: texto de rodada intermediária ("vou gerar o arquivo...")
// não pode mais aparecer concatenado com o texto final ("pronto, gerei") quando há ferramenta
// envolvida. Sem ferramenta nenhuma, continua concatenando tudo (comportamento de sempre).
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) { return { id: c.split('/').pop(), path: c, async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; }, async set(dados, opts) { banco.set(c, opts && opts.merge ? { ...(banco.get(c) || {}), ...dados } : dados); }, collection: (n) => colRef(`${c}/${n}`) }; }
let seq = 0;
function colRef(c) { const q = { orderBy: () => q, limit: () => q, get: async () => { const docs = [...banco.keys()].filter((k) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).map((k) => ({ id: k.split('/').pop(), data: () => banco.get(k), ref: docRef(k) })); return { docs }; } }; return { ...q, doc: (id) => docRef(`${c}/${id || 'auto' + (++seq)}`), async add(dados) { const r = docRef(`${c}/auto${++seq}`); await r.set(dados); return r; } }; }
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

(async () => {
  console.log('1) texto "vou gerar" + tool_use, depois "pronto" -> só o final aparece');
  prepararEmpresa();
  roteiro = [
    resp([txt('Vou gerar o arquivo agora.'), uso('gerar_arquivo', { tipo: 'lanctos', linhas: [{ data: '10/08/2026', debito: '1', credito: '2', valor: 5, codigoEmp: '185' }] })], 'tool_use'),
    resp([txt('Pronto, gerei o arquivo — revise antes de importar.')], 'end_turn'),
  ];
  let r = await pedido('gera');
  confere('texto final é só a confirmação', r.text === 'Pronto, gerei o arquivo — revise antes de importar.', r.text);
  confere('não sobrou o anúncio "vou gerar"', !r.text.includes('Vou gerar'));

  console.log('\n2) conversa sem ferramenta continua concatenando tudo (comportamento de sempre)');
  prepararEmpresa();
  roteiro = [resp([txt('Oi! Como posso ajudar?')], 'end_turn')];
  r = await pedido('oi');
  confere('texto normal, sem ferramenta', r.text === 'Oi! Como posso ajudar?', r.text);

  console.log('\n3) pause_turn sem ferramenta nenhuma continua juntando os pedaços');
  prepararEmpresa();
  roteiro = [
    resp([txt('Parte 1 da explicação...')], 'pause_turn'),
    resp([txt('parte 2, terminando aqui.')], 'end_turn'),
  ];
  r = await pedido('explica tudo');
  confere('junta as duas partes (sem ferramenta, comportamento preservado)', r.text === 'Parte 1 da explicação...\n\nparte 2, terminando aqui.', r.text);

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
