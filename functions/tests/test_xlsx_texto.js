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
  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
