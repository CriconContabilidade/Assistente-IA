// Testa dois achados do Codex:
// - campoEstruturalTxt não pode "engolir" quebra de linha / caractere de controle como se fosse
//   espaço — isso é dado corrompido, igual a ";", e tem que dar erro explícito.
// - toLatin1Base64 não pode trocar caractere fora do ANSI por "?" sem avisar quem vai conferir.
const fs = require('fs');
const src = fs.readFileSync('C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js', 'utf8');

let falhas = 0;
function confere(nome, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome.padEnd(55)} -> ${JSON.stringify(obtido)}${ok ? '' : '  (esperado ' + JSON.stringify(esperado) + ')'}`);
}

console.log('campoEstruturalTxt: quebra de linha / caractere de controle (achado do Codex)');
{
  const a = src.indexOf('function campoTxt');
  const b = src.indexOf('// obrigatorio=false permite data em branco');
  const m = { exports: {} };
  new Function('module', src.slice(a, b) + '\nmodule.exports={campoTxt, campoEstruturalTxt};')(m);
  const { campoEstruturalTxt } = m.exports;
  function testa(v) { try { return { r: campoEstruturalTxt(v, 'código da conta') }; } catch (e) { return { erro: e.message }; } }
  confere('valor normal continua ok', testa('123'), { r: '123' });
  confere('CR/LF no meio dá erro (não vira espaço escondido)', !!testa('123\n456').erro && testa('123\n456').erro.includes('quebra de linha'), true);
  confere('CRLF (\\r\\n) também dá erro', !!testa('123\r\n456').erro, true);
  confere('tab também é caractere de controle -> erro', !!testa('123\t456').erro, true);
  confere('";" continua dando erro (comportamento já existente)', !!testa('123;456').erro, true);
}

console.log('\ntoLatin1Base64: caractere fora do ANSI vira "?" mas agora avisa (achado do Codex)');
{
  const a = src.indexOf('function toLatin1Base64');
  const b = src.indexOf('const FILE_NAMES');
  const m = { exports: {} };
  new Function('module', src.slice(a, b) + '\nmodule.exports={toLatin1Base64};')(m);
  const { toLatin1Base64 } = m.exports;
  const semAvisos = [];
  const b64normal = toLatin1Base64('PAGAMENTO NORMAL', semAvisos);
  confere('texto todo ANSI: nenhum aviso', semAvisos.length, 0);
  confere('base64 decodifica igual ao original', Buffer.from(b64normal, 'base64').toString('latin1'), 'PAGAMENTO NORMAL');

  const avisos = [];
  const b64 = toLatin1Base64('PAGAMENTO 🎉 TESTE', avisos);
  confere('emoji vira "?" no conteúdo', Buffer.from(b64, 'base64').toString('latin1').includes('PAGAMENTO ??'), true);
  confere('gera aviso mencionando o caractere trocado', avisos.length === 1 && avisos[0].includes('ANSI/Latin-1'), true);
}

console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
