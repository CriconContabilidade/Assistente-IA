// Testa o achado em uso real: um extrato do mês inteiro, com vários lançamentos SIMPLES (débito
// e crédito na mesma linha, sem relação entre si), virou UM lançamento só dentro do Domínio —
// porque só a primeira linha do arquivo tinha "Inicia Lote" = 1 e o resto ficou em branco. O
// Domínio não tem marcador de "fim de lote": sem o "1" separando, ele emenda um lançamento no
// outro. A regra corrigida: toda linha com débito E crédito preenchidos (lançamento simples)
// SEMPRE leva "1" — só fica em branco numa linha de CONTINUAÇÃO de partida múltipla (só um dos
// dois lados preenchido).
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
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(70)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}
function gerarLanctos(linhas) {
  try { return { arq: buildArquivoGerado({ tipo: 'lanctos', linhas }) }; } catch (e) { return { erro: e.message }; }
}
function colunaIniciaLote(linhaTxt) {
  return linhaTxt.split(';')[6]; // Data;Débito;Crédito;Valor;Cód.Hist.;Complemento;Inicia Lote;...
}
function linhasDoArquivo(base64) {
  return Buffer.from(base64, 'base64').toString('latin1').split('\r\n').filter(Boolean);
}

console.log('lançamentos simples (débito+crédito na mesma linha, sem relação entre si)');
{
  const linhas = [
    { data: '02/06/2026', debito: '354', credito: '7', valor: 37, complemento: 'MATERIAL DE ESCRITORIO' },
    { data: '02/06/2026', debito: '7', credito: '330', valor: 41.40, complemento: 'CUSTAS PROCESSUAIS' },
    { data: '02/06/2026', debito: '25', credito: '7', valor: 1500, complemento: 'PIX FORNECEDOR' },
  ];
  const r = gerarLanctos(linhas);
  confere('gera sem erro', !r.erro, true);
  const txt = linhasDoArquivo(r.arq.base64);
  confere('3 linhas no arquivo', txt.length, 3);
  confere('linha 1 (simples) leva "1" mesmo sem a IA mandar', colunaIniciaLote(txt[0]), '1');
  confere('linha 2 (simples) TAMBÉM leva "1" — achado real: ficava em branco e o Domínio emendava com a linha 1', colunaIniciaLote(txt[1]), '1');
  confere('linha 3 (simples) também leva "1"', colunaIniciaLote(txt[2]), '1');
}

console.log('\nse a IA já mandar "1" explicitamente, continua "1" (não duplica nem quebra)');
{
  const r = gerarLanctos([{ data: '02/06/2026', debito: '354', credito: '7', valor: 37, iniciaLote: '1' }]);
  confere('gera sem erro', !r.erro, true);
  confere('continua "1"', colunaIniciaLote(linhasDoArquivo(r.arq.base64)[0]), '1');
}

console.log('\npartida múltipla continua funcionando: só a linha de abertura leva "1", as de continuação ficam em branco');
{
  const linhas = [
    { data: '02/06/2026', debito: '10', credito: '', valor: 300, iniciaLote: '1', complemento: 'RATEIO A' },
    { data: '02/06/2026', debito: '11', credito: '', valor: 200, complemento: 'RATEIO B' },
    { data: '02/06/2026', debito: '', credito: '58', valor: 500, complemento: 'RATEIO FECHA' },
  ];
  const r = gerarLanctos(linhas);
  confere('gera sem erro (débitos batem com créditos)', !r.erro, true);
  const txt = linhasDoArquivo(r.arq.base64);
  confere('linha 1 (abre o lote) leva "1"', colunaIniciaLote(txt[0]), '1');
  confere('linha 2 (continuação, só débito) fica em branco', colunaIniciaLote(txt[1]), '');
  confere('linha 3 (continuação, só crédito) fica em branco', colunaIniciaLote(txt[2]), '');
}

console.log('\nlote que não fecha continua dando erro (não muda por causa do achado novo)');
{
  const linhas = [
    { data: '02/06/2026', debito: '10', credito: '', valor: 300, iniciaLote: '1' },
    { data: '02/06/2026', debito: '', credito: '58', valor: 250 },
  ];
  const r = gerarLanctos(linhas);
  confere('erro de lote que não fecha', !!r.erro && r.erro.includes('não fecha'), true);
}

console.log('\nsequência real: lançamentos simples misturados com uma partida múltipla no meio');
{
  const linhas = [
    { data: '02/06/2026', debito: '354', credito: '7', valor: 37, complemento: 'SIMPLES 1' },
    { data: '02/06/2026', debito: '25', credito: '7', valor: 1500, complemento: 'SIMPLES 2' },
    { data: '02/06/2026', debito: '10', credito: '', valor: 100, iniciaLote: '1', complemento: 'RATEIO A' },
    { data: '02/06/2026', debito: '', credito: '58', valor: 100, complemento: 'RATEIO FECHA' },
    { data: '02/06/2026', debito: '7', credito: '330', valor: 41.40, complemento: 'SIMPLES 3' },
  ];
  const r = gerarLanctos(linhas);
  confere('gera sem erro', !r.erro, true);
  const txt = linhasDoArquivo(r.arq.base64);
  confere('simples 1 leva "1"', colunaIniciaLote(txt[0]), '1');
  confere('simples 2 leva "1" (não é continuação do 1)', colunaIniciaLote(txt[1]), '1');
  confere('abertura da partida múltipla leva "1"', colunaIniciaLote(txt[2]), '1');
  confere('fechamento da partida múltipla fica em branco (continuação)', colunaIniciaLote(txt[3]), '');
  confere('simples 3 (depois da partida múltipla) leva "1" de novo', colunaIniciaLote(txt[4]), '1');
}

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
