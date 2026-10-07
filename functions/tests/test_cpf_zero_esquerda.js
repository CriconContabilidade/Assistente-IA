// Achado em uso real (Mantovani): CPF com zero à esquerda chegou sem ele (557.018.102-4, 10
// dígitos) e o arquivo saiu com erro/aviso. Completa o zero só quando o dígito verificador
// confirma que é aquele documento; se não confirma, continua recusando.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

const a1 = src.indexOf('function validarCnpjCpfDv');
const b1 = src.indexOf('function stripAccentsJs');
const trecho = src.slice(a1, b1);
const m = { exports: {} };
new Function('module', trecho + '\nmodule.exports={documentoTxt};')(m);
const { documentoTxt } = m.exports;

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(70)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}
function dvCpf(base9) {
  const calc = (digs) => {
    const soma = digs.reduce((acc, d, i) => acc + d * (digs.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d = base9.split('').map(Number);
  const d1 = calc(d);
  const d2 = calc([...d, d1]);
  return `${base9}${d1}${d2}`;
}
function tenta(valor) {
  const avisos = [];
  try { return { r: documentoTxt(valor, 'CPF', true, avisos), avisos }; } catch (e) { return { erro: e.message, avisos }; }
}

const cpfComZero = dvCpf('012345678'); // 11 dígitos, começa com 0
const semZero = cpfComZero.slice(1); // 10 dígitos, como chega quando o zero se perde

console.log('CPF sem o zero da frente');
{
  const r = tenta(semZero);
  confere('completa o zero quando o dígito verificador confere', r.r, cpfComZero);
  confere('avisa que completou', r.avisos.length === 1 && r.avisos[0].includes('faltava zero'), true);
}
{
  const r = tenta(semZero.slice(0, 9) + (semZero[9] === '9' ? '0' : String(Number(semZero[9]) + 1)));
  confere('com dígito verificador que não confere continua recusando', !!r.erro, true);
}
console.log('\nDocumentos normais não mudam');
{
  const r = tenta(cpfComZero);
  confere('CPF completo passa direto, sem aviso', [r.r, r.avisos.length], [cpfComZero, 0]);
}

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
