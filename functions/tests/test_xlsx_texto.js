// Planilhas viram texto para a IA sem linhas vazias nem colunas vazias no fim (menos tokens).
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const a = src.indexOf('function cellToString');
const b = src.indexOf('// ---------------- geração de arquivo');
if (a === -1 || b === -1) throw new Error('nao achei xlsxBufferToText');
const m = { exports: {} };
new Function('module', 'ExcelJS', src.slice(a, b) + '\nmodule.exports = { xlsxBufferToText };')(m, ExcelJS);

let falhas = 0;
const confere = (nome, ok, detalhe = '') => { if (!ok) falhas++; console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`); };

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Plan1');
  ws.addRow(['Data', 'Historico', 'Valor', '', '', '']);
  ws.addRow(['', '', '', '', '', '']);
  ws.addRow(['10/08/2026', 'Tarifa', 93.1, '', '', '']);
  ws.addRow(['11/08/2026', '', 10, '', 'obs', '']);
  ws.addRow([0, 0]);
  const texto = await m.exports.xlsxBufferToText(Buffer.from(await wb.xlsx.writeBuffer()));
  const linhas = texto.split('\n').filter((l) => !l.startsWith('---'));
  confere('linha só de células vazias some', !linhas.some((l) => l.trim() === ''), JSON.stringify(linhas));
  confere('colunas vazias do fim da linha são cortadas', linhas[0] === 'Data\tHistorico\tValor', JSON.stringify(linhas[0]));
  confere('célula vazia no MEIO continua (as colunas não deslocam)', linhas.includes('11/08/2026\t\t10\t\tobs'), JSON.stringify(linhas));
  confere('zero é dado, não é removido', linhas.includes('0\t0'), JSON.stringify(linhas));

  // planilha com muitas abas: só as primeiras abas dentro do orçamento, o resto fica pra buscar_arquivo
  const grande = new ExcelJS.Workbook();
  for (let i = 1; i <= 120; i++) {
    const w = grande.addWorksheet(`Mes${i}`);
    for (let r = 1; r <= 60; r++) w.addRow([`item ${r} da aba ${i}`, r * 10.5, 'observacao longa o bastante pra ocupar espaco']);
  }
  const bufGrande = Buffer.from(await grande.xlsx.writeBuffer());
  const todo = await m.exports.xlsxBufferToText(bufGrande, { maxChars: 1e9 });
  const padrao = await m.exports.xlsxBufferToText(bufGrande);
  confere('padrão manda só uma fração das abas (orçamento de caracteres)', padrao.length < 60000 && padrao.length < todo.length / 5, `${padrao.length} de ${todo.length}`);
  confere('a primeira aba vem; as últimas não', padrao.includes('--- Planilha: Mes1 ---') && !padrao.includes('--- Planilha: Mes120 ---'));
  confere('o aviso diz o total de abas, quais foram e quais ficaram de fora', /tem 120 abas/.test(padrao) && /Abas NÃO enviadas: Mes\d+/.test(padrao) && /e mais \d+/.test(padrao) && padrao.includes('"abas"'));
  const pedida = await m.exports.xlsxBufferToText(bufGrande, { abas: ['mes77', '3'] });
  confere('aba pedida pelo nome (sem diferenciar maiúscula) ou número vem inteira, e só ela', pedida.includes('--- Planilha: Mes77 ---') && pedida.includes('--- Planilha: Mes3 ---') && !pedida.includes('--- Planilha: Mes1 ---'));
  confere('mesmo com abas escolhidas, a IA é avisada de que existem outras (e que não deve inventar)', /tem 120 abas; só 2 foram enviadas \(Mes3, Mes77\)/.test(pedida) && /Abas NÃO enviadas: Mes1,/.test(pedida) && /Não invente dados/.test(pedida));
  const inexistente = await m.exports.xlsxBufferToText(bufGrande, { abas: ['nao existe'] });
  confere('aba que não existe devolve a lista de abas, sem erro', /Nenhuma aba com esse nome/.test(inexistente) && inexistente.includes('Mes120'));
  confere('planilha pequena não recebe aviso nenhum', !/Aviso do sistema/.test(texto));


  // números sem ruído de ponto flutuante (menos tokens, mesmo valor pra um lançamento)
  const wbNum = new ExcelJS.Workbook();
  wbNum.addWorksheet('N').addRow([1234.5678901234567, 0.09250000000000001, 93.1, 1500, 0.000123456789, -7.123456789, 2.675]);
  const textoNum = await m.exports.xlsxBufferToText(Buffer.from(await wbNum.xlsx.writeBuffer()));
  const linhaNum = textoNum.split('\n')[1];
  confere('ruído de ponto flutuante some, valor útil fica', linhaNum === '1234.5679\t0.0925\t93.1\t1500\t0.000123457\t-7.1235\t2.675', JSON.stringify(linhaNum));

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
