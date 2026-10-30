// Testa a function excluirEmpresa: só admin, confere o nome digitado e apaga empresa + subcoleções
// (recursiveDelete). Nada disso toca o banco de verdade.
const Module = require('module');
const ARQ = require('path').join(__dirname, '..', 'index.js');

const empresas = new Map(); // id -> dados
const apagadas = [];
let marcadaAntes = null;
const fakeDb = {
  collection: (nome) => ({
    doc: (id) => ({
      id, path: `${nome}/${id}`,
      async get() { const d = empresas.get(id); return { exists: d !== undefined, data: () => d }; },
      async update(dados) { empresas.set(id, { ...empresas.get(id), ...dados }); },
    }),
  }),
  async recursiveDelete(ref) { marcadaAntes = empresas.get(ref.id) && empresas.get(ref.id).excluindo === true; apagadas.push(ref.path); empresas.delete(ref.id); },
};

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
const { excluirEmpresa } = require(ARQ);

let falhas = 0;
const confere = (nome, ok, detalhe = '') => { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); };
const ADMIN = { token: { email: 'contabilidadecricon@gmail.com' }, uid: 'u1' };
const chama = async (auth, data) => { try { return { r: await excluirEmpresa({ auth, data }) }; } catch (e) { return { erro: e }; } };

(async () => {
  empresas.set('emp1', { nome: 'Mantovani Ltda' });
  empresas.set('emp2', { nome: '' });

  let x = await chama(null, { empresaId: 'emp1', confirmacaoNome: 'Mantovani Ltda' });
  confere('sem login é recusado', x.erro && x.erro.code === 'unauthenticated');
  x = await chama({ token: { email: 'funcionario@cricon.com.br' }, uid: 'u2' }, { empresaId: 'emp1', confirmacaoNome: 'Mantovani Ltda' });
  confere('funcionário (não admin) é recusado', x.erro && x.erro.code === 'permission-denied');
  x = await chama(ADMIN, { empresaId: 'emp1', confirmacaoNome: 'outro nome' });
  confere('nome que não confere é recusado e nada é apagado', x.erro && x.erro.code === 'invalid-argument' && apagadas.length === 0 && empresas.has('emp1'));
  x = await chama(ADMIN, { empresaId: 'emp1' });
  confere('sem nome de confirmação é recusado', x.erro && x.erro.code === 'invalid-argument' && apagadas.length === 0);
  x = await chama(ADMIN, { empresaId: '../outra', confirmacaoNome: 'x' });
  confere('id com barra/caminho é recusado', x.erro && x.erro.code === 'invalid-argument');
  x = await chama(ADMIN, { empresaId: 'nao-existe', confirmacaoNome: 'x' });
  confere('empresa inexistente: not-found', x.erro && x.erro.code === 'not-found');

  x = await chama(ADMIN, { empresaId: 'emp1', confirmacaoNome: '  MANTOVANI ltda ' });
  confere('nome certo (sem diferenciar maiúscula/espaços) apaga a empresa com recursiveDelete', x.r && x.r.ok === true && apagadas.join() === 'assistenteIA_empresas/emp1' && !empresas.has('emp1'), JSON.stringify(x));

  confere('a empresa é marcada como "excluindo" ANTES de apagar (bloqueia pedidos e gravações em andamento)', marcadaAntes === true);

  x = await chama(ADMIN, { empresaId: 'emp2', confirmacaoNome: 'qualquer coisa' });
  confere('empresa sem nome: só a palavra EXCLUIR confirma', x.erro && x.erro.code === 'invalid-argument' && empresas.has('emp2'));
  x = await chama(ADMIN, { empresaId: 'emp2', confirmacaoNome: 'excluir' });
  confere('empresa sem nome: "excluir" apaga', x.r && x.r.ok === true && !empresas.has('emp2'));

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
