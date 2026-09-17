// Testa migrarPadroesEstruturados (item 2 da Fase 3): grava os padrões extraídos na
// subcoleção certa, remove SÓ o texto de padrões antigo (PADROES_SEED_DETALHADO da Fase 1)
// das observações — preservando qualquer outra observação real —, e é idempotente.
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) {
  return {
    id: c.split('/').pop(), path: c,
    async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados, opts) { banco.set(c, opts && opts.merge ? { ...(banco.get(c) || {}), ...dados } : dados); },
    async update(dados) { banco.set(c, { ...(banco.get(c) || {}), ...dados }); },
    collection: (n) => colRef(`${c}/${n}`),
  };
}
let seq = 0;
function colRef(c) {
  const q = { orderBy: () => q, limit: () => q, get: async () => {
    const docs = [...banco.keys()].filter((k) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/'))
      .map((k) => ({ id: k.split('/').pop(), data: () => banco.get(k), ref: docRef(k) }));
    return { docs, empty: docs.length === 0 };
  } };
  return { ...q, doc: (id) => docRef(`${c}/${id || 'auto' + (++seq)}`), async add(dados) { const r = docRef(`${c}/auto${++seq}`); await r.set(dados); return r; } };
}
const fakeDb = { collection: (n) => colRef(n) };

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (o, f) => f, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'x' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'T', arrayUnion: (...x) => ({ __union: x }) } },
  'firebase-admin/auth': { getAuth: () => ({}) },
  '@anthropic-ai/sdk': class {},
  exceljs: {},
  'firebase/app': { initializeApp: () => ({}) },
  'firebase/auth': { getAuth: () => ({}), signInAnonymously: async () => ({}) },
  'firebase/firestore': { getFirestore: () => ({}), doc: () => ({}), collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}), getDoc: async () => ({ exists: () => false, data: () => ({}) }), getDocs: async () => ({ empty: true, docs: [] }) },
};
const orig = Module._load;
Module._load = function (req, p, m) { return req in falsos ? falsos[req] : orig.apply(this, arguments); };
const { migrarPadroesEstruturados } = require(ARQ);

let falhas = 0;
function confere(nome, ok, detalhe = '') { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); }
const padroesDe = (empId) => [...banco.entries()].filter(([k]) => k.startsWith(`assistenteIA_empresas/${empId}/padroes/`)).map(([, v]) => v);

(async () => {
  console.log('1) não-admin é recusado');
  let erro = null;
  try { await migrarPadroesEstruturados({ auth: { token: { email: 'funcionario@cricon.com.br' } } }); }
  catch (e) { erro = e; }
  confere('permission-denied', erro && erro.code === 'permission-denied');

  console.log('\n2) empresa reconhecida (Bari) recebe os padrões e perde o texto antigo');
  banco.clear();
  banco.set('assistenteIA_empresas/bari', {
    nome: 'Bari',
    notas: [
      'Regime tributário: Lucro Presumido',
      'Padrões de lançamento (extrato) — parte 1:\n"TARIFA COBRANÇA" -> Débito 384 / Crédito 20, histórico "x"',
      'Data e CNPJ são corrigidos automaticamente — sempre revisar antes de exportar',
    ],
  });
  banco.set('assistenteIA_empresas/desconhecida', { nome: 'Empresa Sem Dados', notas: ['observação qualquer'] });
  const r = await migrarPadroesEstruturados({ auth: { token: { email: 'contabilidadecricon@gmail.com' } } });
  confere('Bari recebeu os 13 padrões estruturados', padroesDe('bari').length === 13, padroesDe('bari').length);
  const notasBari = banco.get('assistenteIA_empresas/bari').notas;
  confere('bloco de texto antigo foi removido', !notasBari.some((n) => n.startsWith('Padrões de lançamento')), notasBari);
  confere('observações reais (regime, revisão) continuam lá', notasBari.includes('Regime tributário: Lucro Presumido') && notasBari.length === 2, notasBari);
  confere('empresa sem dados reconhecidos fica intocada', padroesDe('desconhecida').length === 0 && banco.get('assistenteIA_empresas/desconhecida').notas.length === 1);
  confere('resultado relata a mudança', r.detalhes.some((d) => d.empresa === 'Bari' && d.padroesGravados === 13), JSON.stringify(r.detalhes));

  console.log('\n3) rodar de novo é idempotente (não duplica os padrões)');
  const r2 = await migrarPadroesEstruturados({ auth: { token: { email: 'contabilidadecricon@gmail.com' } } });
  confere('continua com 13 padrões (não dobrou pra 26)', padroesDe('bari').length === 13, padroesDe('bari').length);

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
