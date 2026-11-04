const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

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

console.log('\nNF DE SERVICO COM IMPOSTO RETIDO: BASE DE CALCULO (erro real da MV: IRRF 22,87 estourava a alíquota)');
const nfBase = { cnpj: '43617343000102', numeroDocumento: '62076', data: '30/10/2026', acumulador: 4, cfps: 9101, valorServicos: 101.64 };
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase, valorIrrf: 22.87 }] });
let c = r.arq && celulasDe(r.arq)[0];
confere('com IRRF e sem base, a base (coluna 16) sai igual ao valor da nota', c && c[15] === '101,64' && c[14] === '101,64' && c[19] === '22,87', c && JSON.stringify(c));
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase, valorIrrf: 3078.8, valorPis: 416.92, valorCofins: 1924.25, valorCsll: 641.42, valorServicos: 64141.75 }] });
c = r.arq && celulasDe(r.arq)[0];
confere('vale também com PIS, COFINS e CSLL retidos', c && c[15] === '64141,75');
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase, valorIrrf: 22.87, baseCalculo: 90 }] });
c = r.arq && celulasDe(r.arq)[0];
confere('base informada pela IA nunca é sobrescrita', c && c[15] === '90');
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase }] });
c = r.arq && celulasDe(r.arq)[0];
confere('nota sem imposto retido continua sem base (nada muda)', c && c[15] === '' && c.length === 28);
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase, valorIrrf: 22.87, aliquotaIss: 5, valorIssNormal: 5.08 }] });
c = r.arq && celulasDe(r.arq)[0];
confere('com ISS na nota a base não é inventada: sai o aviso pedindo a base', c && c[15] === '' && r.arq.avisos.some((a) => /sem base de cálculo/.test(a)), r.arq && JSON.stringify(r.arq.avisos));
r = gera({ tipo: 'servico_prest', linhas: [{ ...nfBase, valorIrrf: 22.87, valorContabil: 100 }] });
c = r.arq && celulasDe(r.arq)[0];
confere('a base usa o valor contábil quando ele difere do valor dos serviços', c && c[15] === '100');

console.log('\nNFS NO LEIAUTE PADRAO (registros 0000, 3000 e 3020) - testado de verdade na MV: o COSIRF 38 grava');
const nfsPadrao = { tipo: 'nfs_padrao', empresaCnpj: '21208224000163', linhas: [{ especie: 67, cnpj: '26989715002903', acumulador: 1, serie: 'U', numeroDocumento: '153', data: '31/10/2026', cfps: 9101, valorServicos: 64141.75, impostos: [{ codigo: 38, valor: 6061.39 }] }] };
r = gera(nfsPadrao);
const linhasPipe = (arq) => Buffer.from(arq.base64, 'base64').toString('latin1').split(/\r?\n/).filter(Boolean);
let lp = r.arq && linhasPipe(r.arq);
confere('arquivo com 3 registros: 0000, 3000 e 3020', lp && lp.length === 3 && lp[0] === '|0000|21208224000163|' && lp[1].startsWith('|3000|') && lp[2].startsWith('|3020|'), lp && JSON.stringify(lp));
confere('registro 3000 idêntico ao arquivo que o Domínio da MV aceitou (32 campos)', lp && lp[1] === '|3000|67|26989715002903||1|U|153|||31/10/2026|31/10/2026|64141,75||||||||0|9101||||||||64141,75|0,00|||' && lp[1].split('|').length === 34, lp && lp[1]);
confere('registro 3020 do COSIRF (38) com 11 campos, base = valor da nota, alíquota 9,45 e valor 6.061,39', lp && lp[2] === '|3020|38||64141,75|9,45|6061,39|0,00|0,00|64141,75|||' && lp[2].split('|').length === 13, lp && lp[2]);
confere('a base NÃO é mexida (o Domínio ignora base e valor do 3020 e recalcula o COSIRF sozinho: ajustar não adiantou na MV)', lp && lp[2].includes('|64141,75|9,45|6061,39|'));
confere('nenhum aviso de ajuste', r.arq && r.arq.avisos.length === 0, r.arq && JSON.stringify(r.arq.avisos));
confere('metadados pra tela montar a conferência por registro', r.arq && r.arq.formato === 'pipe' && r.arq.layouts['3000'].length === 32 && r.arq.layouts['3020'].length === 11 && r.arq.nome === 'NFS_Dominio_Padrao.txt');
confere('quebra de linha do Windows e sem acento', r.arq && Buffer.from(r.arq.base64, 'base64').toString('latin1').endsWith('|\r\n'));
r = gera({ ...nfsPadrao, linhas: [{ ...nfsPadrao.linhas[0], impostos: [{ codigo: 16, valor: 10, base: 100 }] }] });
lp = r.arq && linhasPipe(r.arq);
confere('conta que já fecha não mexe na base nem avisa (100 x 10% = 10)', lp && lp[2] === '|3020|16||100,00|10,00|10,00|0,00|0,00|64141,75|||' && r.arq.avisos.length === 0, lp && lp[2]);
r = gera({ ...nfsPadrao, linhas: [nfsPadrao.linhas[0], { ...nfsPadrao.linhas[0], numeroDocumento: '154', impostos: [] }] });
lp = r.arq && linhasPipe(r.arq);
confere('duas notas: um 0000 só, cada 3000 seguido dos seus impostos', lp && lp.length === 4 && lp.filter((x) => x.startsWith('|0000|')).length === 1 && lp[1].includes('|153|') && lp[2].startsWith('|3020|') && lp[3].includes('|154|'));
r = gera({ ...nfsPadrao, linhas: [{ ...nfsPadrao.linhas[0], especie: undefined }] });
confere('sem código da espécie: erro claro', !!r.erro && /espécie/.test(r.erro), r.erro);
r = gera({ ...nfsPadrao, empresaCnpj: '' });
confere('empresa sem CNPJ: erro claro (o registro 0000 precisa dele)', !!r.erro && /CNPJ da empresa/.test(r.erro), r.erro);
r = gera({ ...nfsPadrao, linhas: [{ ...nfsPadrao.linhas[0], impostos: [{ codigo: 38, valor: 90000 }] }] });
confere('alíquota fora de 0 a 100% (o erro que estourou a coluna na MV) é recusada antes de gerar', !!r.erro && /fora do possível/.test(r.erro), r.erro);
r = gera({ ...nfsPadrao, linhas: [{ ...nfsPadrao.linhas[0], fatoGeradorCosirf: 'X' }] });
confere('fato gerador só aceita E ou P', !!r.erro && /E \(emissão\) ou P/.test(r.erro), r.erro);
r = gera({ ...nfsPadrao, linhas: [{ ...nfsPadrao.linhas[0], fatoGeradorCosirf: 'p', observacao: 'Aluguel | outubro; ref. “Sócio”' }] });
lp = r.arq && linhasPipe(r.arq);
confere('fato gerador P entra na posição 17; observação sem "|" nem ";"', lp && lp[1].split('|')[17] === 'P' && lp[1].split('|')[13] === 'Aluguel outubro ref. "Socio"', lp && lp[1]);

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
