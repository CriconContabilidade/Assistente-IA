// Testa o achado do Codex (item 12): arquivosGerados carrega o base64 inteiro do arquivo
// dentro do documento do Firestore (mensagens/{id} e processamentos/{requestId}) — um lote de
// lançamentos grande o bastante gera um TXT que estoura o limite de 1 MiB do Firestore e
// derrubava a gravação inteira, mesmo com a IA já tendo feito todo o trabalho. Acima do limite,
// grava só os metadados (nome/tipo/linhas/avisos), sem o base64.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');
const a = src.indexOf('const LIMITE_BASE64_EM_DOC_CHARS');
const b = src.indexOf('// Guarda o arquivo original junto da ficha do documento');
const m = { exports: {} };
new Function('module', src.slice(a, b) + '\nmodule.exports={arquivosGeradosParaGravar};')(m);
const { arquivosGeradosParaGravar } = m.exports;

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(60)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}

const pequeno = [{ nome: 'lanctos.txt', base64: 'QUJD', tipo: 'lanctos', linhas: 3, avisos: [] }];
confere('arquivo pequeno passa direto, com o base64', arquivosGeradosParaGravar(pequeno), pequeno);

const grande = [{ nome: 'lanctos.txt', base64: 'A'.repeat(800 * 1024), tipo: 'lanctos', linhas: 9000, avisos: [] }];
const resultado = arquivosGeradosParaGravar(grande);
confere('arquivo grande demais: base64 vira null', resultado[0].base64, null);
confere('arquivo grande demais: metadados continuam (nome, tipo, linhas)',
  resultado[0].nome === 'lanctos.txt' && resultado[0].tipo === 'lanctos' && resultado[0].linhas === 9000, true);
confere('arquivo grande demais: fica marcado', resultado[0].grandeDemaisPraGravar, true);

const doisMedios = [
  { nome: 'baixa_ent.txt', base64: 'A'.repeat(400 * 1024), tipo: 'baixa_ent', linhas: 100, avisos: [] },
  { nome: 'baixa_ser.txt', base64: 'B'.repeat(400 * 1024), tipo: 'baixa_ser', linhas: 100, avisos: [] },
];
const resultadoSoma = arquivosGeradosParaGravar(doisMedios);
confere('soma de dois arquivos médios que juntos estouram: os dois perdem o base64',
  resultadoSoma.every((a) => a.base64 === null), true);

const semArquivo = [];
confere('lista vazia não quebra', arquivosGeradosParaGravar(semArquivo), []);

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
