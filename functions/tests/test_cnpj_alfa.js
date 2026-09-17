const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');
const a = src.indexOf('function validarCnpjCpfDv');
const b = src.indexOf('function stripAccentsJs', a);
const m = { exports: {} };
new Function('module', src.slice(a, b) + '\nmodule.exports={validarCnpjCpfDv, normalizarDocumento, documentoTxt};')(m);
const { validarCnpjCpfDv, normalizarDocumento, documentoTxt } = m.exports;

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(52)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}
function doc(valor, obrigatorio = false) {
  const avisos = [];
  try { return { r: documentoTxt(valor, 'CNPJ', obrigatorio, avisos), avisos: avisos.length }; }
  catch (e) { return { erro: e.message }; }
}

console.log('CNPJ ALFANUMERICO');
confere('exemplo oficial da Receita valida', validarCnpjCpfDv('12ABC34501DE35'), true);
confere('exemplo oficial com mascara', doc('12.ABC.345/01DE-35'), { r: '12ABC34501DE35', avisos: 0 });
confere('minusculas viram maiusculas', doc('12.abc.345/01de-35'), { r: '12ABC34501DE35', avisos: 0 });
confere('DV errado da mensagem especifica', doc('12.ABC.345/01DE-36').erro.includes('dígito verificador não confere'), true);

console.log('\nNADA MUDA PARA O QUE JA EXISTIA');
const reais = ['43.617.343/0001-02', '21.208.224/0001-63', '10.572.359/0001-97', '26.989.715/0029-03'];
for (const c of reais) confere(`CNPJ numerico ${c}`, doc(c), { r: c.replace(/\D/g, ''), avisos: 0 });
confere('CNPJ numerico com DV errado so avisa', doc('43.617.343/0001-03'), { r: '43617343000103', avisos: 1 });
confere('CPF com mascara', doc('529.982.247-25'), { r: '52998224725', avisos: 0 });
confere('"CPF 529..." continua virando o CPF', doc('CPF 529.982.247-25'), { r: '52998224725', avisos: 0 });
confere('"CNPJ: 43.617..." continua virando o CNPJ', doc('CNPJ: 43.617.343/0001-02'), { r: '43617343000102', avisos: 0 });
confere('"ISENTO" em campo opcional continua em branco', doc('ISENTO'), { r: '', avisos: 0 });
confere('vazio em campo opcional continua em branco', doc(''), { r: '', avisos: 0 });
confere('vazio em campo obrigatorio continua erro', !!doc('', true).erro, true);
confere('numero curto continua erro', doc('123').erro, 'CNPJ deve ter 11 (CPF) ou 14 (CNPJ) caracteres');

console.log('\nCNPJ ALFANUMERICO INVALIDO NAO VIRA CPF DE OUTRA PESSOA (achado da auditoria)');
confere('letra colada em CPF valido -> erro, NAO virou CPF de outra pessoa',
  doc('ABC52998224725').erro && doc('ABC52998224725').erro.includes('dígito verificador não confere'), true);
confere('letra colada, so 11 chars ao todo -> erro claro, nao vira CPF por acaso',
  !!doc('AB998224725').erro, true);

console.log('\nCOMPARACAO COM O COMPORTAMENTO ANTIGO (qualquer entrada so com numeros)');
const antigo = (v) => String(v ?? '').replace(/\D/g, '');
let diferentes = 0;
const amostras = ['43617343000102', '4361734300010', '52998224725', '00.000.000/0000-00', 'CPF 111.444.777-35',
  'Doc nº 21208224000163', 'x', '12 34', null, undefined, 123, 'CNPJ 10.572.359/0001-97 (Cricon)'];
for (const v of amostras) if (normalizarDocumento(v) !== antigo(v)) { diferentes++; console.log('  diferente:', v); }
confere('entradas sem CNPJ alfanumerico valido: identicas ao antigo', diferentes, 0);

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
