// Testa o achado 6 (parte custom claims) da auditoria: ehAdmin() aceita claim OU e-mail (rede
// de segurança durante a transição), e sincronizarClaimsAdmin() seta o claim nos 3 admins sem
// duplicar nem sobrescrever outros claims que a pessoa já tivesse.
const Module = require('module');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

const usuariosAuth = new Map(); // email -> { uid, customClaims }
const authFalso = {
  async getUserByEmail(email) {
    const u = usuariosAuth.get(email);
    if (!u) { const e = new Error('no user record'); e.code = 'auth/user-not-found'; throw e; }
    return { uid: u.uid, customClaims: u.customClaims };
  },
  async setCustomUserClaims(uid, claims) {
    for (const [email, u] of usuariosAuth) if (u.uid === uid) u.customClaims = claims;
  },
};

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (o, f) => f, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'x' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': { getFirestore: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }), FieldValue: { serverTimestamp: () => 'T', arrayUnion: (...x) => ({ __union: x }) } },
  'firebase-admin/auth': { getAuth: () => authFalso },
  '@anthropic-ai/sdk': class {},
  exceljs: {},
  'firebase/app': { initializeApp: () => ({}) },
  'firebase/auth': { getAuth: () => ({}), signInAnonymously: async () => ({}) },
  'firebase/firestore': { getFirestore: () => ({}), doc: () => ({}), collection: () => ({}), query: () => ({}), where: () => ({}), limit: () => ({}), getDoc: async () => ({ exists: () => false, data: () => ({}) }), getDocs: async () => ({ empty: true, docs: [] }) },
};
const orig = Module._load;
Module._load = function (req, p, m) { return req in falsos ? falsos[req] : orig.apply(this, arguments); };
const { sincronizarClaimsAdmin } = require(ARQ);

let falhas = 0;
function confere(nome, ok, detalhe = '') { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); }

(async () => {
  console.log('1) não-admin (nem por e-mail, nem por claim) é recusado');
  let erro = null;
  try { await sincronizarClaimsAdmin({ auth: { token: { email: 'funcionario@cricon.com.br' } } }); }
  catch (e) { erro = e; }
  confere('permission-denied', erro && erro.code === 'permission-denied');

  console.log('\n2) admin por e-mail (ainda sem claim) consegue rodar — rede de segurança funcionando');
  usuariosAuth.set('contabilidadecricon@gmail.com', { uid: 'uid-1', customClaims: null });
  usuariosAuth.set('guilherme.primetherapy@gmail.com', { uid: 'uid-2', customClaims: { algumaCoisa: true } });
  // rh@cricon.com.br propositalmente NÃO existe ainda no Auth (nunca logou)
  const r = await sincronizarClaimsAdmin({ auth: { token: { email: 'contabilidadecricon@gmail.com' } } });
  confere('processou os 3 e-mails', r.resultado.length === 3, JSON.stringify(r.resultado));
  confere('primeiro recebeu o claim agora', r.resultado[0].status === 'claim adicionado agora', r.resultado[0]);
  confere('segundo recebeu o claim SEM apagar o claim que já tinha', usuariosAuth.get('guilherme.primetherapy@gmail.com').customClaims.algumaCoisa === true && usuariosAuth.get('guilherme.primetherapy@gmail.com').customClaims.admin === true);
  confere('terceiro (nunca logou) reporta erro claro, não trava tudo', r.resultado[2].status.includes('não deu'), r.resultado[2]);
  confere('avisa sobre logout/login', r.aviso.includes('logout'));

  console.log('\n3) rodar de novo não duplica nem reseta (idempotente)');
  const r2 = await sincronizarClaimsAdmin({ auth: { token: { email: 'contabilidadecricon@gmail.com' } } });
  confere('segunda vez já reporta "já tinha"', r2.resultado[0].status === 'já tinha o claim', r2.resultado[0]);

  console.log('\n4) admin SÓ por claim (sem estar na lista de e-mail) também é aceito — a troca funciona no sentido oposto');
  const semLista = await sincronizarClaimsAdmin({ auth: { token: { email: 'nao-esta-na-lista@cricon.com.br', admin: true } } });
  confere('claim sozinho basta pra rodar a function admin-only', Array.isArray(semLista.resultado));

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
