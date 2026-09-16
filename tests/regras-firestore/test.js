const fs = require('fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, orderBy,
} = require('firebase/firestore');

const ADMIN = 'contabilidadecricon@gmail.com';
const FUNC = 'func@cricon.com.br';
const OUTRO = 'outro@cricon.com.br';

let falhas = 0;
async function caso(nome, esperado, promessa) {
  try {
    if (esperado === 'ok') await assertSucceeds(promessa);
    else await assertFails(promessa);
    console.log(`  ok    ${nome}`);
  } catch (e) {
    falhas++;
    console.log(`  FALHA ${nome}  (${e.message.split('\n')[0]})`);
  }
}

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-stagiario',
    firestore: { rules: fs.readFileSync(process.env.REGRAS || require('path').join(__dirname, '../../../Banco-de-Horas/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
  });

  // dados de partida, gravados ignorando as regras (como a Cloud Function faz)
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = { notas: [], criadoEm: new Date() };
    await setDoc(doc(db, 'assistenteIA_empresas/livre'), { ...base, nome: 'Livre', responsavelEmail: '' });
    await setDoc(doc(db, 'assistenteIA_empresas/minha'), { ...base, nome: 'Minha', responsavelEmail: FUNC });
    await setDoc(doc(db, 'assistenteIA_empresas/alheia'), { ...base, nome: 'Alheia', responsavelEmail: OUTRO });
    await setDoc(doc(db, 'assistenteIA_empresas/semcampo'), { ...base, nome: 'Sem campo' });
    await setDoc(doc(db, 'assistenteIA_empresas/semcampo2'), { ...base, nome: 'Sem campo 2' });
    await setDoc(doc(db, 'assistenteIA_empresas/minha/fechamentos/2026-09'), { competencia: '09/2026' });
    for (const id of ['minha', 'alheia']) {
      await setDoc(doc(db, `assistenteIA_empresas/${id}/mensagens/m1`), { role: 'user', text: 'oi' });
      await setDoc(doc(db, `assistenteIA_empresas/${id}/documentos/d1`), { resumo: 'x' });
      await setDoc(doc(db, `assistenteIA_empresas/${id}/fechamentos/2026-08`), { competencia: '08/2026' });
    }
  });

  const admin = env.authenticatedContext('admin', { email: ADMIN }).firestore();
  const func = env.authenticatedContext('func', { email: FUNC }).firestore();
  // e-mail com maiúsculas no login: a regra baixa pra minúsculas
  const funcMaiusc = env.authenticatedContext('func2', { email: 'Func@Cricon.com.br' }).firestore();
  const anonimo = env.unauthenticatedContext().firestore();
  const col = (db) => collection(db, 'assistenteIA_empresas');

  console.log('ADMIN');
  await caso('lista todas as empresas (consulta ampla)', 'ok', getDocs(query(col(admin), orderBy('nome'))));
  await caso('lê empresa de outro', 'ok', getDoc(doc(admin, 'assistenteIA_empresas/alheia')));
  await caso('troca o responsável', 'ok', updateDoc(doc(admin, 'assistenteIA_empresas/livre'), { responsavelEmail: FUNC }));
  await caso('volta o responsável', 'ok', updateDoc(doc(admin, 'assistenteIA_empresas/livre'), { responsavelEmail: '' }));
  await caso('lê mensagens de qualquer empresa', 'ok', getDocs(collection(admin, 'assistenteIA_empresas/alheia/mensagens')));
  await caso('corrige campo ausente (normalização)', 'ok', updateDoc(doc(admin, 'assistenteIA_empresas/semcampo'), { responsavelEmail: '' }));

  console.log('FUNCIONÁRIO — lista (como o app consulta)');
  await caso('consulta "sem responsável"', 'ok', getDocs(query(col(func), where('responsavelEmail', '==', ''))));
  await caso('consulta "responsável = eu"', 'ok', getDocs(query(col(func), where('responsavelEmail', '==', FUNC))));
  await caso('consulta ampla é recusada', 'falha', getDocs(query(col(func), orderBy('nome'))));
  await caso('consulta pelo e-mail de outro é recusada', 'falha', getDocs(query(col(func), where('responsavelEmail', '==', OUTRO))));
  const livres = await getDocs(query(col(func), where('responsavelEmail', '==', '')));
  const minhas = await getDocs(query(col(func), where('responsavelEmail', '==', FUNC)));
  const nomes = [...livres.docs, ...minhas.docs].map((d) => d.data().nome).sort().join(', ');
  const esperados = 'Livre, Minha, Sem campo';
  if (nomes === esperados) console.log(`  ok    enxerga exatamente: ${nomes}`);
  else { falhas++; console.log(`  FALHA enxerga "${nomes}", esperado "${esperados}"`); }

  console.log('FUNCIONÁRIO — empresa');
  await caso('lê a própria', 'ok', getDoc(doc(func, 'assistenteIA_empresas/minha')));
  await caso('lê a sem responsável', 'ok', getDoc(doc(func, 'assistenteIA_empresas/livre')));
  await caso('NÃO lê a de outro', 'falha', getDoc(doc(func, 'assistenteIA_empresas/alheia')));
  await caso('edita observações da própria', 'ok', updateDoc(doc(func, 'assistenteIA_empresas/minha'), { notas: ['tarifa na 384'] }));
  await caso('NÃO edita a de outro', 'falha', updateDoc(doc(func, 'assistenteIA_empresas/alheia'), { notas: ['x'] }));
  await caso('NÃO troca o responsável', 'falha', updateDoc(doc(func, 'assistenteIA_empresas/minha'), { responsavelEmail: OUTRO }));
  await caso('NÃO se atribui empresa livre', 'falha', updateDoc(doc(func, 'assistenteIA_empresas/livre'), { responsavelEmail: FUNC }));
  await caso('cria empresa sem responsável', 'ok', addDoc(col(func), { nome: 'Nova', responsavelEmail: '', notas: [] }));
  await caso('NÃO cria empresa já atribuída', 'falha', addDoc(col(func), { nome: 'Nova2', responsavelEmail: OUTRO, notas: [] }));
  await caso('NÃO apaga empresa', 'falha', deleteDoc(doc(func, 'assistenteIA_empresas/minha')));

  console.log('FUNCIONÁRIO — conversa, documentos, fechamento');
  await caso('lê mensagens da própria', 'ok', getDocs(query(collection(func, 'assistenteIA_empresas/minha/mensagens'), orderBy('text'))));
  await caso('envia mensagem na própria', 'ok', addDoc(collection(func, 'assistenteIA_empresas/minha/mensagens'), { role: 'user', text: 'oi' }));
  await caso('NÃO lê mensagens de outro', 'falha', getDocs(collection(func, 'assistenteIA_empresas/alheia/mensagens')));
  await caso('NÃO envia mensagem em outro', 'falha', addDoc(collection(func, 'assistenteIA_empresas/alheia/mensagens'), { role: 'user', text: 'x' }));
  await caso('NÃO apaga mensagem', 'falha', deleteDoc(doc(func, 'assistenteIA_empresas/minha/mensagens/m1')));
  await caso('lê documentos da própria', 'ok', getDocs(collection(func, 'assistenteIA_empresas/minha/documentos')));
  await caso('NÃO lê documentos de outro', 'falha', getDocs(collection(func, 'assistenteIA_empresas/alheia/documentos')));
  await caso('NÃO grava documento', 'falha', setDoc(doc(func, 'assistenteIA_empresas/minha/documentos/d2'), { resumo: 'x' }));
  await caso('lê fechamentos da própria (como o painel)', 'ok', getDocs(collection(func, 'assistenteIA_empresas/minha/fechamentos')));
  const fechs = await getDocs(collection(func, 'assistenteIA_empresas/minha/fechamentos'));
  const recente = fechs.docs.reduce((acc, d) => (!acc || d.id > acc.id ? d : acc), null);
  if (recente && recente.data().competencia === '09/2026') console.log('  ok    painel escolhe a competência mais recente (09/2026)');
  else { falhas++; console.log('  FALHA painel escolheu', recente && recente.data().competencia); }
  await caso('NÃO lê fechamento de outro', 'falha', getDocs(collection(func, 'assistenteIA_empresas/alheia/fechamentos')));
  await caso('NÃO grava fechamento', 'falha', setDoc(doc(func, 'assistenteIA_empresas/minha/fechamentos/2026-09'), { competencia: '09/2026' }));

  console.log('CASOS DE BORDA');
  await caso('login com maiúsculas lê a própria', 'ok', getDoc(doc(funcMaiusc, 'assistenteIA_empresas/minha')));
  await caso('login com maiúsculas consulta a própria', 'ok',
    getDocs(query(col(funcMaiusc), where('responsavelEmail', '==', FUNC))));
  await caso('sem login não lê nada', 'falha', getDoc(doc(anonimo, 'assistenteIA_empresas/livre')));
  await caso('empresa antiga sem o campo fica oculta até o admin corrigir', 'falha', getDoc(doc(func, 'assistenteIA_empresas/semcampo2')));

  await env.cleanup();
  console.log(falhas === 0 ? '\nTODOS OS CASOS PASSARAM' : `\n${falhas} CASO(S) FALHARAM`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
