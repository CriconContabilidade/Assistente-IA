// Testa os achados 5 (sanitização estrutural vs texto livre) e 9 (competência inválida) da
// auditoria técnica.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(48)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}

console.log('ITEM 5 — sanitização estrutural vs texto livre');
{
  const a = src.indexOf('function campoTxt');
  const b = src.indexOf('function dataTxt');
  const m = { exports: {} };
  new Function('module', src.slice(a, b) + '\nmodule.exports={campoTxt, campoEstruturalTxt};')(m);
  const { campoTxt, campoEstruturalTxt } = m.exports;

  confere('campoTxt (texto livre) troca ; por -', campoTxt('Pgto NF 123; parcela 2', 'x'), 'Pgto NF 123 - parcela 2');
  let erro = null;
  try { campoEstruturalTxt('384;7', 'débito da linha 1'); } catch (e) { erro = e.message; }
  confere('campoEstruturalTxt (conta) dá ERRO com ; em vez de mascarar', !!erro && erro.includes('não pode conter'), true);
  confere('campoEstruturalTxt aceita valor normal sem ;', campoEstruturalTxt('384', 'débito'), '384');
  confere('campoEstruturalTxt obrigatório ausente continua dando erro', (() => {
    try { campoEstruturalTxt('', 'número', true); return null; } catch (e) { return e.message; }
  })(), 'Campo obrigatório ausente: número');
}

console.log('\nNOS GERADORES DE VERDADE (débito com ; não vira "384 - 7" escondido)');
{
  const a2 = src.indexOf('function decodificarTexto');
  const b2 = src.indexOf('// Converte um arquivo anexado');
  const a3 = src.indexOf('function cellToString');
  const b3 = src.indexOf('function buildSystemPrompt');
  const trecho = [src.slice(a2, b2), src.slice(a3, b3)].join('\n');
  const m2 = { exports: {} };
  new Function('module', 'require', 'TEXT_MEDIA_TYPES', 'SPREADSHEET_MEDIA_TYPES', 'IMAGE_MEDIA_TYPES', 'xlsxBufferToText',
    trecho + '\nmodule.exports={buildArquivoGerado};')(m2, require, new Set(), new Set(), new Set(), null);
  const { buildArquivoGerado } = m2.exports;
  let erro = null;
  try {
    buildArquivoGerado({ tipo: 'lanctos', linhas: [{ data: '10/08/2026', debito: '384;7', credito: '2', valor: 100, codigoEmp: '185' }] });
  } catch (e) { erro = e.message; }
  confere('débito "384;7" dá erro (não vira "384 - 7" no arquivo)', !!erro && erro.includes('débito'), true);
}

console.log('\nITEM 9 — competência inválida');
{
  const a = src.indexOf('function competenciaParaId');
  const b = src.indexOf('function ', a + 10);
  const m = { exports: {} };
  new Function('module', src.slice(a, b) + '\nmodule.exports={competenciaParaId};')(m);
  const { competenciaParaId } = m.exports;

  confere('mês válido', competenciaParaId('08/2026'), '2026-08');
  confere('mês 00 é recusado', competenciaParaId('00/2026'), null);
  confere('mês 13 é recusado', competenciaParaId('13/2026'), null);
  confere('mês 1 dígito é recusado (formato)', competenciaParaId('8/2026'), null);
  confere('ano fora da faixa é recusado', competenciaParaId('08/1999'), null);
  confere('formato totalmente errado', competenciaParaId('agosto/2026'), null);
  confere('mês 12 (limite) é aceito', competenciaParaId('12/2026'), '2026-12');
  confere('mês 01 (limite) é aceito', competenciaParaId('01/2026'), '2026-01');

  console.log('\n  ordenação: "2026-13" nunca aparece pra vencer "2026-12"');
  const ids = ['08/2026', '13/2026', '12/2026'].map(competenciaParaId).filter(Boolean);
  const maisRecente = ids.reduce((acc, id) => (!acc || id > acc ? id : acc), null);
  confere('competência mais recente escolhida é 2026-12, não a inválida', maisRecente, '2026-12');
}

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
