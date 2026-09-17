// Testa a nova Cloud Function seedObservacoesEmpresas (item 1 da auditoria): admin-only,
// idempotente, aditiva, sem sobrescrever observação já editada por alguém.
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const banco = new Map();
function docRef(c) {
  return {
    id: c.split('/').pop(), path: c,
    async get() { const d = banco.get(c); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados) { banco.set(c, { ...(banco.get(c) || {}), ...dados }); },
    async update(dados) {
      const atual = banco.get(c) || {};
      const novo = { ...atual };
      for (const [k, v] of Object.entries(dados)) {
        if (v && v.__union) novo[k] = [...new Set([...(atual[k] || []), ...v.__union])];
        else novo[k] = v;
      }
      banco.set(c, novo);
    },
    collection: (n) => colRef(`${c}/${n}`),
  };
}
let seq = 0;
function colRef(c) {
  return {
    doc: (id) => docRef(`${c}/${id || 'auto' + (++seq)}`),
    async get() {
      const docs = [...banco.keys()].filter((k) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/'))
        .map((k) => ({ id: k.split('/').pop(), data: () => banco.get(k), ref: docRef(k) }));
      return { docs };
    },
  };
}
const fakeDb = { collection: (n) => colRef(n) };

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (o, f) => f, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'x' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'T', arrayUnion: (...x) => ({ __union: x }) } },
  '@anthropic-ai/sdk': class {},
  exceljs: {},
  'firebase/app': { initializeApp: () => ({}) },
  'firebase/auth': { getAuth: () => ({}), signInAnonymously: async () => ({}) },
  'firebase/firestore': { getFirestore: () => ({}), doc: () => ({}), collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}), getDoc: async () => ({ exists: () => false, data: () => ({}) }), getDocs: async () => ({ empty: true, docs: [] }) },
};
const orig = Module._load;
Module._load = function (req, p, m) { return req in falsos ? falsos[req] : orig.apply(this, arguments); };

const { seedObservacoesEmpresas } = require(ARQ);

let falhas = 0;
function confere(nome, ok, detalhe = '') { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); }

(async () => {
  banco.clear();
  banco.set('assistenteIA_empresas/bari', { nome: 'Bari', notas: [] });
  banco.set('assistenteIA_empresas/mv', { nome: 'MV', notas: ['observação já existente do usuário'] });
  banco.set('assistenteIA_empresas/desconhecida', { nome: 'Empresa Sem Seed', notas: [] });

  console.log('1) não-admin é recusado');
  let erro = null;
  try { await seedObservacoesEmpresas({ auth: { token: { email: 'funcionario@cricon.com.br' } }, data: {} }); }
  catch (e) { erro = e; }
  confere('permission-denied', erro && erro.code === 'permission-denied', erro && erro.message);
  confere('não mexeu em nada', banco.get('assistenteIA_empresas/bari').notas.length === 0);

  console.log('\n2) admin roda a semeadura');
  const r1 = await seedObservacoesEmpresas({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: {} });
  confere('Bari recebeu observações + padrões (empresa nova, sem nota)', banco.get('assistenteIA_empresas/bari').notas.length > 1, banco.get('assistenteIA_empresas/bari').notas.length);
  confere('MV NÃO teve a observação existente apagada', banco.get('assistenteIA_empresas/mv').notas.includes('observação já existente do usuário'));
  confere('empresa sem seed conhecido fica intocada', banco.get('assistenteIA_empresas/desconhecida').notas.length === 0);
  confere('resultado reporta as empresas mudadas', r1.empresasAtualizadas >= 1, JSON.stringify(r1.detalhes));

  console.log('\n3) rodar de novo é idempotente (não duplica)');
  const notasBariAntes = banco.get('assistenteIA_empresas/bari').notas.length;
  await seedObservacoesEmpresas({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: {} });
  const notasBariDepois = banco.get('assistenteIA_empresas/bari').notas.length;
  confere('Bari tem o MESMO número de notas na 2a rodada', notasBariAntes === notasBariDepois, `${notasBariAntes} -> ${notasBariDepois}`);

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
