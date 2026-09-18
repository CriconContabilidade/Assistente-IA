const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');

function recorta(inicio, fim) {
  const a = src.indexOf(inicio);
  const b = src.indexOf(fim, a + 1);
  if (a === -1 || b === -1) throw new Error(`nao achei ${inicio}`);
  return src.slice(a, b);
}
const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/csv", "application/csv", "application/x-ofx", "text/ofx"]);
const trecho = [
  recorta('function decodificarTexto', '// Converte um arquivo anexado'),
  recorta('function cellToString', 'function buildSystemPrompt'),
].join('\n');
const m = { exports: {} };
new Function('module', 'require', 'TEXT_MEDIA_TYPES', 'SPREADSHEET_MEDIA_TYPES', 'IMAGE_MEDIA_TYPES', 'xlsxBufferToText',
  trecho + '\nmodule.exports={decodificarTexto, buildArquivoGerado, stripAccentsJs, toLatin1Base64};')(
  m, require, TEXT_MEDIA_TYPES, new Set(), new Set(), null);
const { decodificarTexto, buildArquivoGerado, stripAccentsJs, toLatin1Base64 } = m.exports;

let falhas = 0;
function confere(nome, ok, detalhe = '') {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`);
}
function gera(spec) {
  try { return { arq: buildArquivoGerado(spec) }; } catch (e) { return { erro: e.message }; }
}
const celulasDe = (arq) => Buffer.from(arq.base64, 'base64').toString('latin1').split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
const L = (o) => ({ data: '10/08/2026', codigoEmp: '185', ...o });

console.log('LOTES (partidas multiplas)');
let r = gera({ tipo: 'lanctos', linhas: [
  L({ debito: '8', valor: 1000, iniciaLote: '1', complemento: 'Recebimento aluguel' }),
  L({ credito: '120', valor: 700 }),
  L({ credito: '121', valor: 300 }),
] });
confere('lote que fecha e aceito', !!r.arq, r.erro);
if (r.arq) console.log('      ' + celulasDe(r.arq).map((c) => c.join(';')).join('\n      '));

r = gera({ tipo: 'lanctos', linhas: [
  L({ debito: '8', valor: 1000, iniciaLote: '1' }),
  L({ credito: '120', valor: 700 }),
] });
confere('lote que nao fecha e recusado', !!r.erro, r.erro);

r = gera({ tipo: 'lanctos', linhas: [L({ debito: '8', valor: 100 })] });
confere('linha de um lado so fora de lote e recusada', !!r.erro, r.erro);

r = gera({ tipo: 'lanctos', linhas: [
  L({ debito: '1', credito: '2', valor: 10.1, iniciaLote: '1' }),
  L({ debito: '3', valor: 0.2 }),
  L({ credito: '4', valor: 0.2 }),
] });
confere('centavos (0,1+0,2) nao quebram a soma', !!r.arq, r.erro);

r = gera({ tipo: 'lanctos', linhas: [
  L({ debito: '8', valor: 50, iniciaLote: '1' }), L({ credito: '9', valor: 50 }),
  L({ debito: '8', valor: 30, iniciaLote: '1' }), L({ credito: '9', valor: 20 }),
] });
confere('segundo lote desbalanceado e apontado', !!r.erro && r.erro.includes('linha 3'), r.erro);

console.log('\nARQUIVO REAL DE AGOSTO (MV) continua gerando');
const agosto = JSON.parse(fs.readFileSync(__dirname + '/msg.txt', 'utf8').match(/\{"tipo":"lanctos"[\s\S]*\]\}/)[0]);
r = gera(agosto);
confere(`lanctos de agosto (${agosto.linhas.length} linhas)`, !!r.arq, r.erro);

console.log('\nAVISO DE DIGITO VERIFICADOR');
r = gera({ tipo: 'baixa_ent', linhas: [{ numero: '1', cnpj: '43.617.343/0001-03', databaixa: '03/08/2026', valor: 10 }] });
confere('CNPJ com DV errado gera arquivo E aviso', !!r.arq && r.arq.avisos.length === 1, r.arq && r.arq.avisos[0]);
r = gera({ tipo: 'baixa_ent', linhas: [{ numero: '1', cnpj: '43.617.343/0001-02', databaixa: '03/08/2026', valor: 10 }] });
confere('CNPJ correto nao gera aviso', !!r.arq && r.arq.avisos.length === 0);
r = gera({ tipo: 'servico_prest', linhas: [{ cnpj: '21208224000160', numeroDocumento: '1', data: '10/08/2026', acumulador: 4, cfps: 9101, valorServicos: 1 }] });
confere('NF com DV errado tambem avisa', !!r.arq && r.arq.avisos.length === 1);

console.log('\nSANITIZACAO E CARACTERES');
r = gera({ tipo: 'lanctos', linhas: [L({ debito: '1', credito: '2', valor: 5, complemento: 'Pgto NF 123; parcela 2\r\nref. agosto' })] });
const hist = r.arq && celulasDe(r.arq)[0][5];
confere('ponto e virgula e quebra de linha no historico viram texto', hist === 'Pgto NF 123 - parcela 2 ref. agosto', hist);
confere('arquivo continua com 10 colunas', r.arq && celulasDe(r.arq)[0].length === 10);
const limpo = stripAccentsJs('Transferência – “Sócio” — ‘Ágil’ • ok');
confere('travessao, aspas curvas e marcador viram ASCII', limpo === 'Transferencia - "Socio" - \'Agil\' * ok', limpo);
const latin = Buffer.from(toLatin1Base64(limpo), 'base64').toString('latin1');
confere('nada vira "?" no arquivo ANSI', !latin.includes('?'), latin);
r = gera({ tipo: 'lanctos', linhas: [L({ data: '2026-08-06', debito: '1', credito: '2', valor: 5 })] });
confere('data ISO vira DD/MM/AAAA', r.arq && celulasDe(r.arq)[0][0] === '06/08/2026', r.arq && celulasDe(r.arq)[0][0]);

console.log('\nLEITURA DE TEXTO (OFX / TXT do Dominio)');
const ofx1252 = Buffer.from('OFXHEADER:100\r\nCHARSET:1252\r\n<MEMO>TRANSFERÊNCIA PIX – SÓCIO', 'latin1');
const t1 = decodificarTexto(ofx1252);
confere('OFX em ANSI mantem os acentos', t1.includes('TRANSFERÊNCIA') && t1.includes('SÓCIO') && !t1.includes('\uFFFD'), t1.split('\n').pop());
const t2 = decodificarTexto(Buffer.from('<MEMO>PAGAMENTO CONDOMÍNIO', 'utf8'));
confere('OFX em UTF-8 continua certo', t2.includes('CONDOMÍNIO'), t2);

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
