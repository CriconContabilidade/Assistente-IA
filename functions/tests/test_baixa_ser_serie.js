// Testa o achado em uso real: baixa_ser.txt não incluía a coluna "série" — o título de Baixa
// de Serviços nasce de uma Nota Fiscal (ServicoPrest.txt, que sempre leva série), e sem ela
// aqui o Domínio não localiza o título certo: tudo desalinhava uma posição pra frente,
// "Data de Baixa" recebendo o valor do lançamento, e (nas linhas que passavam) o lançamento
// saía com "Conta cliente" e valor zerados. baixa_sai (fornecedor de saída, sem série) NÃO
// muda — só baixa_ser ganha a coluna extra.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');

const a2 = src.indexOf('function decodificarTexto');
const b2 = src.indexOf('// Converte um arquivo anexado');
const a3 = src.indexOf('function cellToString');
const b3 = src.indexOf('function buildSystemPrompt');
const trecho = [src.slice(a2, b2), src.slice(a3, b3)].join('\n');
const m = { exports: {} };
new Function('module', 'require', 'TEXT_MEDIA_TYPES', 'SPREADSHEET_MEDIA_TYPES', 'IMAGE_MEDIA_TYPES', 'xlsxBufferToText',
  trecho + '\nmodule.exports={buildArquivoGerado};')(m, require, new Set(), new Set(), new Set(), null);
const { buildArquivoGerado } = m.exports;

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(65)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}
function gerar(tipo, linhas) {
  try { return { arq: buildArquivoGerado({ tipo, linhas }) }; } catch (e) { return { erro: e.message }; }
}
function linhasDoArquivo(base64) {
  return Buffer.from(base64, 'base64').toString('latin1').split('\r\n').filter(Boolean);
}

console.log('baixa_ser.txt: coluna "série" logo depois do número do título');
{
  const linhas = [{ numero: '74', cnpj: '11496657000108', vencimento: '29/05/2026', databaixa: '02/06/2026', valor: 7938.85 }];
  const r = gerar('baixa_ser', linhas);
  confere('gera sem erro', !r.erro, true);
  const campos = linhasDoArquivo(r.arq.base64)[0].split(';');
  confere('13 colunas (12 de sempre + série)', campos.length, 13);
  confere('campo 1 = número do título', campos[0], '74');
  confere('campo 2 = série (default "U" quando a IA não manda)', campos[1], 'U');
  confere('campo 3 = CNPJ (empurrado uma posição pela série)', campos[2], '11496657000108');
  confere('campo 4 = vencimento', campos[3], '29/05/2026');
  confere('campo 5 = data da baixa (é exatamente aqui que o Domínio esperava e não achava)', campos[4], '02/06/2026');
  confere('campo 6 = valor', campos[5], '7938,85');
}

console.log('\nbaixa_ser.txt: série explícita da IA é respeitada (não força sempre "U")');
{
  const r = gerar('baixa_ser', [{ numero: '10', serie: '2', vencimento: '01/06/2026', databaixa: '02/06/2026', valor: 100 }]);
  confere('gera sem erro', !r.erro, true);
  confere('usa a série mandada, não o default', linhasDoArquivo(r.arq.base64)[0].split(';')[1], '2');
}

console.log('\nbaixa_sai.txt: NÃO ganha a coluna série (só baixa_ser precisa)');
{
  const r = gerar('baixa_sai', [{ numero: '74', cnpj: '11496657000108', vencimento: '29/05/2026', databaixa: '02/06/2026', valor: 7938.85 }]);
  confere('gera sem erro', !r.erro, true);
  const campos = linhasDoArquivo(r.arq.base64)[0].split(';');
  confere('continua com 12 colunas, sem série', campos.length, 12);
  confere('campo 2 continua sendo o CNPJ (não série)', campos[1], '11496657000108');
}

console.log('\nbaixa_ent.txt: também não ganha série (fornecedor, sem NF do lado nosso)');
{
  const r = gerar('baixa_ent', [{ numero: '74', cnpj: '11496657000108', vencimento: '29/05/2026', databaixa: '02/06/2026', valor: 100 }]);
  confere('gera sem erro', !r.erro, true);
  confere('continua com 8 colunas', linhasDoArquivo(r.arq.base64)[0].split(';').length, 8);
}

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
