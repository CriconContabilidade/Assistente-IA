// Limite mensal de consumo por empresa: padrões (US$ 1,50 / 1,00), limite gravado, percentual,
// virada de mês no fuso de Brasília e o momento em que o limite é considerado atingido.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
const a = src.indexOf('const LIMITE_GERAL_PADRAO_USD');
const b = src.indexOf('// Soma o gasto de uma chamada');
const m = { exports: {} };
new Function('module', 'db', src.slice(a, b) +
  '\nmodule.exports={limiteGeralEscritorio, limiteMensalEmpresa, mesConsumo, percentualUso, limiteAtingido};')(m, null);
const { limiteGeralEscritorio, limiteMensalEmpresa, mesConsumo, percentualUso, limiteAtingido } = m.exports;

let falhas = 0;
const igual = (nome, obtido, esperado) => {
  if (obtido !== esperado) { falhas++; console.log(`FALHOU: ${nome} — esperado ${esperado}, obtido ${obtido}`); }
  else console.log(`ok: ${nome}`);
};

['Ferrara Comércio Ltda', 'GLADIUS Adm', 'Mantovani Empreendimentos', 'Mantonvani', 'Rainha das Cestas',
  'Alexandre Silva ME', 'Serviços Médicos do Vale', 'Servicos Medicos X', 'Sindisaúde', 'Sindisaude SP']
  .forEach((nome) => igual(`limite alto: ${nome}`, limiteMensalEmpresa({ nome }), 0.3));
['Agenor', 'Dario e Freitas', 'Bari', ''].forEach((nome) => igual(`limite padrão: "${nome}"`, limiteMensalEmpresa({ nome }), 0.2));
igual('limite gravado vale mais que o padrão', limiteMensalEmpresa({ nome: "Ferrara", limiteMensalUsd: 3 }), 3);
igual('limite gravado inválido cai no padrão', limiteMensalEmpresa({ nome: 'Agenor', limiteMensalUsd: 0 }), 0.2);
igual('sem empresa', limiteMensalEmpresa(null), 0.2);

igual('42%', percentualUso(0.126, 0.3), 42);
igual('passa de 100%', percentualUso(2, 1), 200);
igual('limite zero não divide', percentualUso(1, 0), 0);
igual('abaixo do limite', limiteAtingido(0.99, 1), false);
igual('exatamente no limite', limiteAtingido(1, 1), true);
igual('acima do limite', limiteAtingido(1.2, 1), true);

igual('teto geral padrão: US$ 20', limiteGeralEscritorio(null), 20);
igual('teto geral gravado vale mais', limiteGeralEscritorio({ limiteUsd: 35 }), 35);
igual('teto geral inválido cai no padrão', limiteGeralEscritorio({ limiteUsd: -1 }), 20);
igual('teto geral atingido em 20', limiteAtingido(20, limiteGeralEscritorio(null)), true);
igual('teto geral ainda livre em 19,99', limiteAtingido(19.99, limiteGeralEscritorio(null)), false);

igual('mês em Brasília (virada às 21h local)', mesConsumo(new Date('2026-11-01T01:30:00Z')), '2026-10');
igual('mês em Brasília (já virou)', mesConsumo(new Date('2026-11-01T03:30:00Z')), '2026-11');
process.exit(falhas ? 1 : 0);
