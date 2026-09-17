// Testa o achado da auditoria (item 4): valor ausente não pode virar "0" silencioso nos
// campos principais (valor do lançamento, valor da baixa, valor dos serviços da NFS).
const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');
const a = src.indexOf('function fmtValorTxt');
const b = src.indexOf('function documentoTxt');
const m = { exports: {} };
new Function('module', src.slice(a, b) +
  '\nmodule.exports={fmtValorTxt, fmtValorOpcionalTxt, valorObrigatorioTxt};')(m);
const { valorObrigatorioTxt } = m.exports;

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(45)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}
function testa(n) {
  try { return { r: valorObrigatorioTxt(n, 'valor da linha 1') }; }
  catch (e) { return { erro: e.message }; }
}

confere('valor presente formata normal', testa(93.1), { r: '93,10' });
confere('valor zero de propósito é aceito (não é "ausente")', testa(0), { r: '0' });
confere('undefined dá erro, não vira 0', testa(undefined).erro, 'Campo obrigatório ausente: valor da linha 1');
confere('null dá erro, não vira 0', testa(null).erro, 'Campo obrigatório ausente: valor da linha 1');
confere('string vazia dá erro, não vira 0', testa('').erro, 'Campo obrigatório ausente: valor da linha 1');

// Confere também nos geradores reais, via buildArquivoGerado
const a2 = src.indexOf('function decodificarTexto');
const b2 = src.indexOf('// Converte um arquivo anexado');
const a3 = src.indexOf('function cellToString');
const b3 = src.indexOf('function findJsonObjectEnd');
const trecho = [src.slice(a2, b2), src.slice(a3, b3)].join('\n');
const m2 = { exports: {} };
new Function('module', 'require', 'TEXT_MEDIA_TYPES', 'SPREADSHEET_MEDIA_TYPES', 'IMAGE_MEDIA_TYPES', 'xlsxBufferToText',
  trecho + '\nmodule.exports={buildArquivoGerado};')(m2, require, new Set(), new Set(), new Set(), null);
const { buildArquivoGerado } = m2.exports;

function gera(spec) {
  try { return { arq: buildArquivoGerado(spec) }; } catch (e) { return { erro: e.message }; }
}

console.log('\nNOS GERADORES DE VERDADE');
let r = gera({ tipo: 'lanctos', linhas: [{ data: '10/08/2026', debito: '1', credito: '2', codigoEmp: '185' }] });
confere('lanctos sem valor -> erro (não gera R$0,00)', !!r.erro && r.erro.includes('valor'), true);

r = gera({ tipo: 'baixa_ent', linhas: [{ numero: '1', databaixa: '10/08/2026' }] });
confere('baixa_ent sem valor -> erro (não baixa R$0,00)', !!r.erro && r.erro.includes('valor'), true);

r = gera({ tipo: 'servico_prest', linhas: [{ cnpj: '21208224000163', numeroDocumento: '1', data: '10/08/2026', acumulador: 1, cfps: 9101 }] });
confere('NFS sem valorServicos -> erro (não emite nota de R$0,00)', !!r.erro && r.erro.includes('serviços'), true);

// juros/multa/desconto/impostos continuam podendo ficar ausentes (defaultam pra 0, de propósito)
r = gera({ tipo: 'baixa_ent', linhas: [{ numero: '1', databaixa: '10/08/2026', valor: 100 }] });
confere('baixa_ent SEM juros/multa/desconto continua ok (0 de propósito)', !!r.arq, true);
if (r.erro) console.log('   (erro inesperado:', r.erro, ')');

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
