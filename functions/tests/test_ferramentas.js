// Roda o handler REAL do functions/index.js com Anthropic e Firestore simulados — testa o laço
// de ferramentas sem gastar com a API e sem tocar no banco de verdade.
const Module = require('module');
const path = require('path');
const ARQ = require('path').join(__dirname, '..', 'index.js');

// ---------- Firestore em memória ----------
const banco = new Map(); // caminho do doc -> dados
function temListaDeListas(v) {
  if (Array.isArray(v)) return v.some((x) => Array.isArray(x) || temListaDeListas(x));
  if (v && typeof v === 'object') return Object.values(v).some(temListaDeListas);
  return false;
}
function aplicarMerge(atual, novo) {
  const r = { ...(atual || {}) };
  for (const [k, v] of Object.entries(novo)) {
    if (v && v.__union) r[k] = [...new Set([...(r[k] || []), ...v.__union])];
    else r[k] = v;
  }
  return r;
}
let seq = 0;
function docRef(caminho) {
  return {
    id: caminho.split('/').pop(),
    path: caminho,
    async get() { const d = banco.get(caminho); return { exists: !!d, id: this.id, data: () => d, ref: this }; },
    async set(dados, opts) {
      if (temListaDeListas(dados)) throw new Error('Nested arrays are not supported');
      banco.set(caminho, opts && opts.merge ? aplicarMerge(banco.get(caminho), dados) : aplicarMerge({}, dados));
    },
    collection: (nome) => colRef(`${caminho}/${nome}`),
  };
}
function colRef(caminho) {
  const listar = async () => {
    const docs = [...banco.keys()]
      .filter((k) => k.startsWith(caminho + '/') && !k.slice(caminho.length + 1).includes('/'))
      .map((k) => ({ id: k.split('/').pop(), data: () => banco.get(k), ref: docRef(k) }));
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
  };
  const q = { orderBy: () => q, limit: () => q, get: listar };
  return {
    ...q,
    doc: (id) => docRef(`${caminho}/${id || 'auto' + (++seq)}`),
    async add(dados) { const r = docRef(`${caminho}/auto${++seq}`); await r.set(dados); return r; },
  };
}
let falhasTransacao = 0; // quantas transações (consumo) devem falhar antes de funcionar
const fakeDb = {
  collection: (n) => colRef(n),
  async runTransaction(fn) {
    if (falhasTransacao > 0) { falhasTransacao--; throw new Error('transação falhou (simulado)'); }
    const tx = {
      async get(ref) { return ref.get(); },
      set(ref, dados, opts) { banco.set(ref.path, opts && opts.merge ? aplicarMerge(banco.get(ref.path), dados) : aplicarMerge({}, dados)); },
      update(ref, dados) { banco.set(ref.path, aplicarMerge(banco.get(ref.path), dados)); },
    };
    return fn(tx);
  },
};

// ---------- Anthropic roteirizado ----------
let roteiro = [];
const chamadas = [];
class FakeAnthropic {
  constructor() {
    const create = async (params) => {
      chamadas.push(JSON.parse(JSON.stringify(params)));
      const passo = roteiro.shift();
      if (!passo) throw new Error('roteiro acabou');
      return typeof passo === 'function' ? passo(params) : passo;
    };
    this.messages = { create, stream: (params) => ({ finalMessage: () => create(params) }) };
  }
}
FakeAnthropic.BadRequestError = class BadRequestError extends Error {};
const txt = (t) => ({ type: 'text', text: t });
let idSeq = 0;
const uso = (name, input) => ({ type: 'tool_use', id: `toolu_${++idSeq}`, name, input });
const resp = (content, stop_reason) => ({ content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } });

// ---------- troca dos módulos ----------
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const falsos = {
  'firebase-functions/v2/https': { onCall: (opts, fn) => fn, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'chave-falsa' }) },
  'firebase-admin/app': { initializeApp() {} },
  'firebase-admin/firestore': {
    getFirestore: () => fakeDb,
    FieldValue: { serverTimestamp: () => 'TS', arrayUnion: (...x) => ({ __union: x }) },
  },
  '@anthropic-ai/sdk': FakeAnthropic,
  exceljs: {},
  'firebase/app': { initializeApp: () => ({}) },
  'firebase/auth': { getAuth: () => ({}), signInAnonymously: async () => ({}) },
  'firebase/firestore': {
    getFirestore: () => ({}),
    // collection() carrega o nome pra getDocs saber qual coleção simulada devolver — sem isso,
    // uma consulta em "empresas_cricon" (lookupEmpresa) acabava lendo o mesmo fixture de
    // "clientes" (clientesCompartilhados) por engano, misturando os dois cadastros no teste.
    collection: (_db, nome) => ({ __col: nome }),
    query: (colRef) => colRef, // mock não filtra de verdade — where/limit só preservam __col
    where: () => ({}), limit: () => ({}),
    // cadastro compartilhado: só o CNPJ do BB existe. O id vai DENTRO da referência (não numa
    // variável global) pra funcionar certo com consultas em paralelo (Promise.all) — uma
    // variável global compartilhada quebraria sob concorrência real, mesmo o código de
    // produção estando correto (o SDK de verdade do Firestore não tem esse problema).
    doc: (_db, _col, id) => ({ id }),
    getDoc: async (ref) => {
      if (cibeleIndisponivel) throw new Error('cadastro compartilhado fora do ar (simulado)');
      return { exists: () => ref.id === '43617343000102', data: () => ({}) };
    },
    // clientesCompartilhados simula "clientes" (fallback de busca por nome sem CNPJ);
    // empresasCriconCompartilhadas simula "empresas_cricon" (código/CNPJ da própria empresa) —
    // coleções separadas, cada uma vazia por padrão até um cenário específico encher.
    getDocs: async (ref) => {
      if (cibeleIndisponivel) throw new Error('cadastro compartilhado fora do ar (simulado)');
      const lista = ref && ref.__col === 'empresas_cricon' ? empresasCriconCompartilhadas : clientesCompartilhados;
      return { empty: lista.length === 0, docs: lista.map((c) => ({ data: () => c })) };
    },
  },
};
// Fica valendo pro arquivo inteiro (não só pro cenário 4b) porque verificarCadastro cacheia a
// coleção em memória por alguns minutos (produção: evita rebaixar milhares de docs a cada
// ferramenta chamada na mesma conversa) — setar isso só depois do primeiro uso não teria
// efeito nos testes seguintes, igual não teria numa conversa de verdade.
let clientesCompartilhados = [
  { razao_social: 'MONLOTE URBANIZADORA LTDA', documento: '59888185000165', tipo: 'CNPJ' },
  { razao_social: 'MARIA SILVA CONSULTORIA LTDA', documento: '11111111000111', tipo: 'CNPJ' },
  { razao_social: 'JOSE SILVA TRANSPORTES LTDA', documento: '22222222000122', tipo: 'CNPJ' },
  // nome duplicado/cortado como vem do Domínio de verdade
  { razao_social: 'FERNANDA CADO FERNANDA CADO WAIHRICH', documento: '52998224725', tipo: 'CPF' },
];
let empresasCriconCompartilhadas = [];
let cibeleIndisponivel = false;
const fsFalso = falsos['firebase/firestore'];
const carregarOriginal = Module._load;
Module._load = function (req, parent, isMain) {
  if (req in falsos) return falsos[req];
  return carregarOriginal.apply(this, arguments);
};
const handler = require(ARQ).assistenteChat;

// ---------- cenários ----------
let falhas = 0;
function confere(nome, ok, detalhe = '') {
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? '  -> ' + detalhe : ''}`);
}
function prepararEmpresa() {
  banco.clear();
  banco.set('assistenteIA_empresas/mv', { nome: 'MV', notas: [], responsavelEmail: '', codigoDominio: '185', cnpj: '21208224000163' });
  banco.set('assistenteIA_empresas/mv/fechamentos/2026-08', { competencia: '08/2026', relatorios: ['extrato'] });
  chamadas.length = 0;
}
const pedido = (message, history = []) => handler({
  auth: { token: { email: 'contabilidadecricon@gmail.com' } },
  data: { empresaId: 'mv', message, history, files: [] },
});
const ctxAtual = (chamada) => {
  const ms = chamada.messages;
  const u = ms[ms.length - 1].content;
  return Array.isArray(u) ? u[0].text : '';
};
const mensagensSalvas = () => [...banco.entries()].filter(([k]) => k.includes('/mensagens/')).map(([, v]) => v);
const LANC = { data: '10/08/2026', debito: '384', credito: '7', valor: 93.1, complemento: 'Tarifa bancaria', codigoEmp: '185' };


// ---------- PDFs mínimos gerados em código (pra testar a conversão em texto) ----------
function criarPdf(paginas) {
  const objs = [];
  const kids = paginas.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  paginas.forEach((c, i) => {
    const n = 4 + i * 2;
    objs[n] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${n + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[n + 1] = `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offs = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
const txtPdf = (x, y, t) => `BT /F1 10 Tf ${x} ${y} Td (${t}) Tj ET\n`;
const PDF_TEXTO = criarPdf([
  txtPdf(50, 700, 'EXTRATO DE CONTA CORRENTE - BANCO TESTE') + txtPdf(50, 680, 'Data') + txtPdf(300, 680, 'Valor')
  + txtPdf(50, 660, '31/08 TARIFA COBRANCA') + txtPdf(300, 660, 'R$ 42,00D')
  + txtPdf(50, 640, '31/08 CREDITO LIQUIDACAO COBRANCA') + txtPdf(300, 640, 'R$ 34.650,00C')
  + txtPdf(50, 620, 'Saldo final do periodo conforme documento original do banco')
  + txtPdf(50, 600, 'Linha extra para o texto passar do minimo exigido pela regra de conversao'),
]);
const PDF_COM_IMAGEM = criarPdf([
  txtPdf(50, 700, 'SAC 0800') + 'q 100 0 0 100 50 500 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q\n',
]);
const arquivoPdf = (nome, buf) => ({ name: nome, mediaType: 'application/pdf', base64: buf.toString('base64') });
const pedidoComArquivos = (message, files) => handler({
  auth: { token: { email: 'contabilidadecricon@gmail.com' } },
  data: { empresaId: 'mv', message, history: [], files },
});
(async () => {
  console.log('1) gera arquivo pela ferramenta');
  prepararEmpresa();
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'lanctos', linhas: [LANC] })], 'tool_use'),
    resp([txt('Aqui está o arquivo, revise antes de importar.')], 'end_turn'),
  ];
  let r = await pedido('gera os lançamentos');
  confere('um arquivo gerado', r.arquivosGerados.length === 1 && r.arquivosGerados[0].nome === 'lanctos.txt');
  confere('texto final certo', r.text === 'Aqui está o arquivo, revise antes de importar.', r.text);
  confere('cache do prompt com TTL de 1h e estado fora do 1º bloco', chamadas[0].system[0].cache_control && chamadas[0].system[0].cache_control.ttl === '1h');
  confere('convenção de histórico e catálogo no bloco fixo (estilo da empresa vence; contas nunca vêm do catálogo)', ['PAGAMENTO REF. <objeto>', 'RECEBIMENTO REF. <objeto>', 'VALOR REF. <objeto>', 'PRECEDÊNCIA', 'HONORARIOS CONTABEIS {MM}/{AAAA} - CRICON CONTABILIDADE', 'VALOR REF. APLICACAO FINANCEIRA - <PRODUTO>', 'NUNCA vêm daqui', 'PROPONHA o texto pronto'].every((f) => chamadas[0].system[0].text.includes(f)));
  confere('personalidade: clichês de contador e de documento difícil, sem piada com gasto do cliente', chamadas[0].system[0].text.includes('Sped') && chamadas[0].system[0].text.includes('torradeira') && chamadas[0].system[0].text.includes('nunca sobre o que o cliente comprou, gastou ou misturou'));
  confere('personalidade: bordões do Michael + regra inviolável dos dados, e sem duplo sentido sexual', chamadas[0].system[0].text.includes('Dundie') && chamadas[0].system[0].text.includes('REGRA INVIOLÁVEL') && chamadas[0].system[0].text.includes('nunca coloque piada dentro de um arquivo gerado') && chamadas[0].system[0].text.includes('nada de duplo sentido sexual') && !/Foi o que ela disse/i.test(chamadas[0].system[0].text));
  confere('personalidade: clichês de estagiário e Nordeste com carinho, sem estigma', /estagiário/.test(chamadas[0].system[0].text) && chamadas[0].system[0].text.includes('acarajé') && chamadas[0].system[0].text.includes('NUNCA piada que mostre nordestino'));
  confere('prompt traz a personalidade (Michael Scott, com 🥁 depois da piada)', chamadas[0].system[0].text.includes('Michael Scott') && chamadas[0].system[0].text.includes('🥁'));
  confere('ferramentas enviadas na chamada', chamadas[0].tools && chamadas[0].tools.map((t) => t.name).join(',') === 'gerar_arquivo,buscar_arquivo,atualizar_fechamento,verificar_cadastro,salvar_codigo_cnpj_empresa,consultar_padrao,salvar_padrao,salvar_observacao', chamadas[0].tools && chamadas[0].tools.map((t) => t.name).join(','));
  const seg = chamadas[1].messages;
  const resultado = seg[seg.length - 1].content[0];
  confere('2a chamada leva tool_use e tool_result com o mesmo id',
    seg[seg.length - 2].content[0].type === 'tool_use' && resultado.type === 'tool_result' && resultado.tool_use_id === seg[seg.length - 2].content[0].id);
  confere('resultado de sucesso sem is_error', !resultado.is_error, resultado.content);
  confere('mensagem salva com o arquivo', mensagensSalvas()[0].arquivosGerados.length === 1);
  confere('arquivo registrado no fechamento de 08/2026', JSON.stringify(banco.get('assistenteIA_empresas/mv/fechamentos/2026-08').arquivos) === '["lanctos.txt"]');

  console.log('\n2) erro nos dados: a IA recebe o erro e corrige sozinha');
  prepararEmpresa();
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'lanctos', linhas: [{ ...LANC, credito: '', iniciaLote: '1' }] })], 'tool_use'),
    (params) => {
      const ult = params.messages[params.messages.length - 1].content[0];
      confere('IA recebeu is_error com o motivo', ult.is_error === true && /lote/.test(ult.content), ult.content);
      return resp([txt('Ajustei o lote.'), uso('gerar_arquivo', { tipo: 'lanctos', linhas: [LANC] })], 'tool_use');
    },
    resp([txt('Pronto, revise antes de importar.')], 'end_turn'),
  ];
  r = await pedido('gera');
  confere('arquivo saiu na segunda tentativa', r.arquivosGerados.length === 1);
  confere('sem aviso de erro no texto final (foi corrigido)', !r.text.includes('Não gerei'), r.text);

  console.log('\n3) erro que não foi corrigido: aviso garantido');
  prepararEmpresa();
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'lanctos', linhas: [{ ...LANC, data: '31/02/2026' }] })], 'tool_use'),
    resp([txt('Aqui está o arquivo!')], 'end_turn'),
  ];
  r = await pedido('gera');
  confere('nenhum arquivo', r.arquivosGerados.length === 0);
  confere('texto avisa que não gerou', r.text.includes('Não gerei o arquivo') && r.text.includes('Data inexistente'), r.text.split('\n').pop());

  console.log('\n4) painel e cadastro pelas ferramentas');
  prepararEmpresa();
  roteiro = [
    resp([
      uso('atualizar_fechamento', { competencia: '08/2026', relatorios: ['contas_pagar', 'inventado'], pendencias: 3 }),
      uso('verificar_cadastro', { entidades: [{ nome: 'BB RF', cnpj: '43.617.343/0001-02' }, { nome: 'Fornecedor X', cnpj: '11.222.333/0001-81' }] }),
    ], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content;
      confere('dois resultados, um por ferramenta', res.length === 2);
      confere('cadastro aponta quem falta', /NÃO encontrados.*Fornecedor X/.test(res[1].content) && /Encontrados.*BB RF/.test(res[1].content), res[1].content);
      confere('cadastro devolve o CNPJ de quem achou (não só confirma que existe)', res[1].content.includes('43617343000102'), res[1].content);
      confere('cadastro informa código e CNPJ da empresa', /código 185, CNPJ 21208224000163/.test(res[1].content));
      return resp([txt('Falta o CNPJ do Fornecedor X.')], 'end_turn');
    },
  ];
  r = await pedido('segue o contas a pagar');
  const fech = banco.get('assistenteIA_empresas/mv/fechamentos/2026-08');
  confere('relatório somado sem apagar o anterior e sem o inventado', JSON.stringify(fech.relatorios) === '["extrato","contas_pagar"]', JSON.stringify(fech.relatorios));
  confere('pendências gravadas', fech.pendencias === 3);

  console.log('\n4b) verificar_cadastro acha por nome quando não tem CNPJ (achado em uso real)');
  prepararEmpresa();
  roteiro = [
    resp([uso('verificar_cadastro', { entidades: [{ nome: 'Monlote Urbanizadora' }] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('acha pelo nome mesmo sem CNPJ', /Encontrados.*Monlote Urbanizadora/.test(res.content), res.content);
      confere('devolve o CNPJ achado pelo nome (não só o nome)', res.content.includes('59888185000165'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere fornecedor sem cnpj');

  console.log('\n4c) cadastro compartilhado fora do ar -> "indisponível", NUNCA "não encontrado" (achado do Codex)');
  prepararEmpresa();
  cibeleIndisponivel = true;
  roteiro = [
    resp([uso('verificar_cadastro', { entidades: [{ nome: 'BB RF', cnpj: '43.617.343/0001-02' }] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('avisa que não conseguiu consultar (não que não existe)', res.content.includes('Não consegui consultar') && !res.content.includes('NÃO encontrados'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere fornecedor com a nuvem fora do ar');
  cibeleIndisponivel = false;

  console.log('\n4d) bate com mais de um nome parecido -> pede confirmação em vez de já pedir CNPJ (pedido do usuário)');
  prepararEmpresa();
  roteiro = [
    resp([uso('verificar_cadastro', { entidades: [{ nome: 'Silva' }] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('não confirma nenhum sozinho, mostra as opções', res.content.includes('MARIA SILVA CONSULTORIA LTDA') && res.content.includes('JOSE SILVA TRANSPORTES LTDA'), res.content);
      confere('pede confirmação, não CNPJ do zero', res.content.includes('confirme') && !res.content.includes('NÃO encontrados'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere fornecedor Silva');

  console.log('\n4e) salvar_codigo_cnpj_empresa grava e fica disponível na mesma conversa (achado em uso real: IA esquecia e perguntava de novo)');
  banco.clear();
  banco.set('assistenteIA_empresas/mv', { nome: 'MV', notas: [], responsavelEmail: '' }); // sem codigoDominio/cnpj, de propósito
  banco.set('assistenteIA_empresas/mv/fechamentos/2026-08', { competencia: '08/2026', relatorios: ['extrato'] });
  chamadas.length = 0;
  roteiro = [
    resp([uso('verificar_cadastro', { entidades: [] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('avisa que a empresa não tem código/CNPJ ainda', res.content.includes('não tem código e CNPJ'), res.content);
      return resp([uso('salvar_codigo_cnpj_empresa', { codigo: '185', cnpj: '21.208.224/0001-63' })], 'tool_use');
    },
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('salva sem erro', !res.is_error, res.content);
      return resp([uso('verificar_cadastro', { entidades: [] })], 'tool_use');
    },
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('já enxerga o código/CNPJ na MESMA conversa, sem reler o Firestore', res.content.includes('código 185') && res.content.includes('CNPJ 21208224000163'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('informa o codigo e cnpj da empresa');
  confere('ficou gravado de verdade no Firestore (sobrevive a nova conversa)',
    banco.get('assistenteIA_empresas/mv').codigoDominio === '185' && banco.get('assistenteIA_empresas/mv').cnpj === '21208224000163',
    banco.get('assistenteIA_empresas/mv'));

  console.log('\n5) buscar arquivo que não existe');
  prepararEmpresa();
  roteiro = [
    resp([uso('buscar_arquivo', { nome: 'nao-existe.pdf' })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('volta is_error', res.is_error === true, res.content);
      return resp([txt('Não achei esse arquivo.')], 'end_turn');
    },
  ];
  await pedido('reabre o extrato');

  console.log('\n6) tag antiga por hábito não vaza pra tela, mas também não executa mais (achado do Codex: segundo caminho de execução sem o schema/validação do tool_use)');
  prepararEmpresa();
  roteiro = [resp([txt('Segue.\n{{GERAR_ARQUIVO:{"tipo":"lanctos","linhas":[{"data":"10/08/2026","debito":"1","credito":"2","valor":5}]}}}\n{{FECHAMENTO:{"competencia":"09/2026","pendencias":0}}}')], 'end_turn')];
  r = await pedido('gera');
  confere('não gera arquivo nenhum a partir da tag (só ferramenta gera)', r.arquivosGerados.length === 0);
  confere('nenhuma tag crua no texto', !r.text.includes('{{'), JSON.stringify(r.text));
  confere('fechamento NÃO é criado pela tag (só ferramenta grava)', !banco.get('assistenteIA_empresas/mv/fechamentos/2026-09'));

  console.log('\n7) conversa sem ferramenta');
  prepararEmpresa();
  roteiro = [resp([txt('Oi! Manda o extrato de agosto.')], 'end_turn')];
  r = await pedido('oi');
  confere('uma chamada só, texto direto', chamadas.length === 1 && r.text === 'Oi! Manda o extrato de agosto.');
  confere('cache no prompt de sistema', chamadas[0].system[0].cache_control && chamadas[0].system[0].cache_control.type === 'ephemeral');

  console.log('\n8) limite de rodadas');
  prepararEmpresa();
  roteiro = Array.from({ length: 10 }, () => resp([uso('atualizar_fechamento', { competencia: '08/2026' })], 'tool_use'));
  r = await pedido('loop');
  confere('parou em 6 chamadas', chamadas.length === 6, String(chamadas.length));
  confere('ainda devolve um texto', typeof r.text === 'string' && r.text.length > 0, r.text);

  console.log('\n9) API recusa as ferramentas: chat continua sem elas');
  prepararEmpresa();
  roteiro = [
    (params) => { throw new FakeAnthropic.BadRequestError('tools: invalid schema'); },
    (params) => {
      confere('segunda tentativa sem ferramentas', !params.tools);
      return resp([txt('Oi, tudo certo.')], 'end_turn');
    },
  ];
  r = await pedido('oi');
  confere('resposta normal', r.text === 'Oi, tudo certo.', r.text);

  console.log('\n10) outro erro da API não é mascarado');
  prepararEmpresa();
  roteiro = [(params) => { throw new Error('rede caiu'); }];
  let erro = null;
  try { await pedido('oi'); } catch (e) { erro = e; }
  confere('vira o erro amigável de sempre', erro && erro.code === 'internal' && /Erro ao falar com a IA/.test(erro.message), erro && erro.message);
  confere('não tentou de novo', chamadas.length === 1);


  console.log('\n10b) histórico de relatórios no prompt fica enxuto (os antigos viram índice)');
  prepararEmpresa();
  for (let i = 1; i <= 10; i++) banco.set(`assistenteIA_empresas/mv/documentos/d${String(i).padStart(2, '0')}`, { arquivos: [`rel${i}.pdf`], resumo: 'X'.repeat(5000) + `FIM${i}` });
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi');
  const promptDocs = chamadas[0].system[1].text;
  const qtdX = (promptDocs.match(/X/g) || []).length;
  confere('só 6 resumos recentes (1500) + 4 antigos (200) entram, não os 50000 caracteres', qtdX >= 9000 && qtdX <= 10000, String(qtdX));
  confere('todos os 10 relatórios continuam listados pelo nome', [1,2,3,4,5,6,7,8,9,10].every((i) => promptDocs.includes(`rel${i}.pdf`)));
  confere('resumo cortado avisa pra usar buscar_arquivo', promptDocs.includes('use buscar_arquivo pra ver o relatório inteiro'));
  banco.clear();

  console.log('\n10c) API recusa o TTL de 1h do cache -> repete com o padrão; cache rolante entre rodadas de ferramenta');
  prepararEmpresa();
  roteiro = [
    () => { throw new FakeAnthropic.BadRequestError('cache_control.ttl: invalid'); },
    resp([uso('atualizar_fechamento', { competencia: '08/2026', pendencias: 1 })], 'tool_use'),
    resp([txt('feito')], 'end_turn'),
  ];
  r = await pedido('oi');
  confere('respondeu normalmente mesmo com a recusa', r.text === 'feito', r.text);
  confere('1ª tentativa pedia 1h', chamadas[0].system[0].cache_control.ttl === '1h');
  confere('repetição saiu sem ttl (cache padrão)', chamadas[1].system[0].cache_control && chamadas[1].system[0].cache_control.ttl === undefined);
  const ultimaMsg = chamadas[2].messages[chamadas[2].messages.length - 1];
  confere('na 2ª rodada o último resultado de ferramenta vira ponto de cache', Array.isArray(ultimaMsg.content) && ultimaMsg.content[ultimaMsg.content.length - 1].cache_control);

  console.log('\n10c2) modelo: usa o Sonnet 5.5 e, se a API não o reconhecer (404), volta pro anterior');
  prepararEmpresa();
  roteiro = [
    () => { const e = new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5-5"}}'); e.status = 404; throw e; },
    resp([txt('respondi')], 'end_turn'),
  ];
  r = await pedido('oi');
  confere('1ª tentativa no Sonnet 5.5', chamadas[0].model === 'claude-sonnet-5-5', chamadas[0].model);
  confere('após o 404 repete no modelo anterior e responde', chamadas[1].model === 'claude-sonnet-5' && r.text === 'respondi', chamadas[1] && chamadas[1].model);
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi de novo');
  confere('conversa normal usa o 5.5 direto', chamadas[0].model === 'claude-sonnet-5-5');

  console.log('\n10d) PDF de texto vai pra IA como texto; PDF com página de imagem segue como PDF');
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue o extrato', [arquivoPdf('extrato.pdf', PDF_TEXTO)]);
  let blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  const blocoTexto = blocosEnviados.find((b) => b.type === 'text' && b.text.includes('PDF convertido em texto'));
  confere('PDF de texto virou bloco de texto (não "document")', !!blocoTexto && !blocosEnviados.some((b) => b.type === 'document'));
  confere('colunas separadas por " | " e valores preservados', blocoTexto && blocoTexto.text.includes('Data | Valor') && blocoTexto.text.includes('R$ 34.650,00C'), blocoTexto && blocoTexto.text.slice(0, 400));
  confere('avisa a IA que existe original=true', blocoTexto && blocoTexto.text.includes('original=true'));

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue o extrato escaneado', [arquivoPdf('escaneado.pdf', PDF_COM_IMAGEM)]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  confere('página com imagem e pouco texto mantém o PDF original', blocosEnviados.some((b) => b.type === 'document'));

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('PDF quebrado', [arquivoPdf('quebrado.pdf', Buffer.from('isto nao e um pdf'))]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  confere('PDF ilegível cai pro original em vez de quebrar a conversa', blocosEnviados.some((b) => b.type === 'document'));

  console.log('\n10e) buscar_arquivo devolve texto por padrão e o PDF original com original=true');
  prepararEmpresa();
  roteiro = [resp([txt('guardei')], 'end_turn')];
  await pedidoComArquivos('guarda esse extrato', [arquivoPdf('rel.pdf', PDF_TEXTO)]);
  chamadas.length = 0;
  roteiro = [
    resp([uso('buscar_arquivo', { nome: 'rel.pdf' })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      const tipos = Array.isArray(res.content) ? res.content.map((b) => b.type).join(',') : String(res.content);
      confere('por padrão reabre em texto', !res.is_error && tipos === 'text,text', tipos);
      return resp([uso('buscar_arquivo', { nome: 'rel.pdf', original: true })], 'tool_use');
    },
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      const tipos = Array.isArray(res.content) ? res.content.map((b) => b.type).join(',') : String(res.content);
      confere('com original=true reabre o PDF', !res.is_error && tipos === 'text,document', tipos);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('olha de novo o rel.pdf');

  console.log('\n10f) PDF com senha: digitada na tela, salva só no servidor e reutilizada');
  const PDF_PROTEGIDO = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'extrato_protegido.pdf'));
  const protegido = (extra = {}) => ({ ...arquivoPdf('extrato_protegido.pdf', PDF_PROTEGIDO), ...extra });
  const blocosDaUltima = () => chamadas[0].messages[chamadas[0].messages.length - 1].content;
  const SENHA_DA_FIXTURE = 'senha123';
  const senhasSalvas = () => (banco.get('assistenteIA_empresas/mv/segredos/senhasPdf') || { lista: [] }).lista.map((x) => x.senha);

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue o extrato protegido', [protegido()]);
  let bl = blocosDaUltima();
  confere('sem senha nenhuma: NÃO manda o PDF cru (a API recusaria) e avisa a IA', !bl.some((b) => b.type === 'document') && bl.some((b) => b.type === 'text' && /NÃO consegui ler este PDF/.test(b.text) && /digitar a senha/.test(b.text)));
  confere('nada foi salvo', senhasSalvas().length === 0);

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue', [protegido({ senha: 'errada' })]);
  bl = blocosDaUltima();
  confere('senha errada: mesmo aviso e nada salvo', bl.some((b) => b.type === 'text' && /NÃO consegui ler este PDF/.test(b.text)) && senhasSalvas().length === 0);

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue', [protegido({ senha: SENHA_DA_FIXTURE })]);
  bl = blocosDaUltima();
  const lido = bl.find((b) => b.type === 'text' && b.text.includes('PDF convertido em texto'));
  confere('senha certa: o PDF é lido como texto', !!lido && lido.text.includes('EXTRATO DE CONTA CORRENTE - BANCO TESTE'), lido && lido.text.slice(0, 200));
  confere('a senha foi salva pra empresa (subcoleção do servidor)', senhasSalvas().join() === SENHA_DA_FIXTURE, senhasSalvas().join());
  confere('a senha NUNCA vai pra IA (nem prompt, nem mensagens)', !JSON.stringify(chamadas).includes(SENHA_DA_FIXTURE));
  confere('a senha não vai pro histórico de mensagens nem de documentos', ![...banco.entries()].some(([k, v]) => !k.includes('/segredos/') && JSON.stringify(v).includes(SENHA_DA_FIXTURE)));

  chamadas.length = 0;
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('outro mês, mesmo banco', [protegido()]);
  bl = blocosDaUltima();
  confere('próxima vez, sem digitar: usa a senha salva', bl.some((b) => b.type === 'text' && b.text.includes('PDF convertido em texto') && b.text.includes('BANCO TESTE')));

  chamadas.length = 0;
  roteiro = [
    resp([uso('buscar_arquivo', { nome: 'extrato_protegido.pdf' })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('buscar_arquivo reabre o PDF protegido com a senha salva', !res.is_error && Array.isArray(res.content) && res.content.some((b) => b.type === 'text' && b.text.includes('BANCO TESTE')), JSON.stringify(res.content).slice(0, 160));
      return resp([uso('buscar_arquivo', { nome: 'extrato_protegido.pdf', original: true })], 'tool_use');
    },
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('original=true num PDF protegido não manda o PDF cru: manda o texto com aviso', Array.isArray(res.content) && !res.content.some((b) => b.type === 'document') && res.content.some((b) => b.type === 'text' && b.text.includes('não pode ser enviado porque tem senha')));
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('reabre o extrato protegido');

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('segue', [protegido({ senha: SENHA_DA_FIXTURE, lembrarSenha: false })]);
  confere('lembrarSenha=false lê o PDF mas não salva a senha', blocosDaUltima().some((b) => b.type === 'text' && b.text.includes('BANCO TESTE')) && senhasSalvas().length === 0);

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  let erroSenha = null;
  try { await pedidoComArquivos('segue', [protegido({ senha: 'x'.repeat(500) })]); } catch (e) { erroSenha = e; }
  confere('senha absurdamente grande é recusada na entrada', erroSenha && erroSenha.code === 'invalid-argument', erroSenha && erroSenha.message);

  console.log('\n10g) prompt em 2 blocos: regras fixas iguais pra toda empresa (cache compartilhado), dados da empresa depois');
  banco.clear();
  banco.set('assistenteIA_empresas/mv', { nome: 'MV', notas: ['MV tem observação própria XYZ'], responsavelEmail: '', codigoDominio: '185', cnpj: '21208224000163' });
  banco.set('assistenteIA_empresas/outra', { nome: 'Outra Empresa Ltda', notas: ['Outra tem regra diferente QWE'], responsavelEmail: '', codigoDominio: '77', cnpj: '43617343000102' });
  chamadas.length = 0;
  const pedidoEmpresa = (id) => handler({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: { empresaId: id, message: 'oi', history: [], files: [] } });
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoEmpresa('mv');
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoEmpresa('outra');
  const [reqA, reqB] = chamadas;
  confere('bloco fixo é IDÊNTICO entre empresas (é isso que permite o cache compartilhado)', reqA.system[0].text === reqB.system[0].text && reqA.system[0].text.length > 20000, String(reqA.system[0].text.length));
  confere('as definições das ferramentas (que vêm antes) também são idênticas', JSON.stringify(reqA.tools) === JSON.stringify(reqB.tools));
  confere('nada da empresa vaza pro bloco fixo', !/MV tem observação|Outra tem regra|Outra Empresa|21208224000163|43617343000102/.test(reqA.system[0].text));
  confere('dados da empresa estão no 2º bloco', reqA.system[1].text.includes('Empresa atual: MV') && reqA.system[1].text.includes('XYZ') && reqB.system[1].text.includes('Empresa atual: Outra Empresa Ltda') && reqB.system[1].text.includes('QWE'));
  confere('painel do fechamento NÃO fica no prompt de sistema (vai na mensagem atual)', !/PAINEL DO FECHAMENTO|Competência em andamento/.test(reqA.system[1].text) && /PAINEL DO FECHAMENTO/.test(ctxAtual(reqA)));
  confere('os dois blocos têm ponto de cache de 1h', reqA.system.every((b) => b.cache_control && b.cache_control.ttl === '1h'));
  confere('as regras não mandam mais olhar "acima" pros dados da empresa', !/resumos acima|resumo acima|lista acima|observações acima/.test(reqA.system[0].text));

  // limite da API: no máximo 4 pontos de cache no pedido inteiro (mesmo com histórico, estado e rodada de ferramenta)
  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/estado/atual', { entidades: [{ nome: 'BB RF', cnpj: '43617343000102' }], pendencias: ['teste'] });
  roteiro = [
    resp([uso('atualizar_fechamento', { competencia: '08/2026', pendencias: 1 })], 'tool_use'),
    resp([uso('verificar_cadastro', { entidades: [] })], 'tool_use'),
    resp([txt('feito')], 'end_turn'),
  ];
  await handler({ auth: { token: { email: 'contabilidadecricon@gmail.com' } }, data: { empresaId: 'mv', message: 'segue', history: [{ role: 'user', text: 'antes' }, { role: 'assistant', text: 'resposta' }], files: [] } });
  const maxPontos = Math.max(...chamadas.map((c) => (JSON.stringify(c).match(/"cache_control"/g) || []).length));
  confere('nunca passa de 4 pontos de cache (limite da API)', maxPontos <= 4 && maxPontos >= 3, String(maxPontos));

  console.log('\n10h) economias: código da empresa preenchido pelo servidor, hash dos arquivos guardados, aviso de Diário com máscara');
  prepararEmpresa();
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'lanctos', linhas: [{ data: '10/08/2026', debito: '384', credito: '7', valor: 93.1, complemento: 'Tarifa' }, { data: '11/08/2026', debito: '384', credito: '7', valor: 10, complemento: 'Outra', codigoEmp: '999' }] })], 'tool_use'),
    resp([txt('ok')], 'end_turn'),
  ];
  r = await pedido('gera sem codigoEmp');
  const lancsTxt = Buffer.from(r.arquivosGerados[0].base64, 'base64').toString('latin1').split('\r\n').filter(Boolean);
  confere('linha sem codigoEmp recebe o código da empresa (185)', lancsTxt[0].split(';')[7] === '185', lancsTxt[0]);
  confere('codigoEmp informado pela IA não é sobrescrito', lancsTxt[1].split(';')[7] === '999', lancsTxt[1]);
  const textoFixo = chamadas[0].system[0].text;
  confere('prompt diz que codigoEmp e campos vazios podem ser omitidos', textoFixo.includes('pode ser omitido') && textoFixo.includes('OMITIR'));
  confere('prompt manda avisar na hora se o Diário vier com máscara em vez de código', textoFixo.includes('ANTES de qualquer outra coisa confira se as contas aparecem pelo CÓDIGO NUMÉRICO') && textoFixo.includes('1.1.2.01.000'));

  prepararEmpresa();
  roteiro = [resp([txt('guardei')], 'end_turn')];
  await pedidoComArquivos('guarda esse extrato', [arquivoPdf('rel.pdf', PDF_TEXTO)]);
  const docsSalvos = [...banco.entries()].filter(([k]) => /\/documentos\/[^/]+$/.test(k)).map(([, v]) => v);
  const info = docsSalvos[0] && docsSalvos[0].arquivosInfo && docsSalvos[0].arquivosInfo[0];
  confere('documento guarda nome, tamanho e hash SHA-256 do arquivo', info && info.nome === 'rel.pdf' && info.tamanho === PDF_TEXTO.length && info.hash === require('crypto').createHash('sha256').update(PDF_TEXTO).digest('hex'), JSON.stringify(info));

  console.log('\n10i) cache: system estável, contexto na mensagem atual, anexo já cacheado na rodada 1, custo no log');
  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/estado/atual', { pendencias: ['primeira'] });
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi');
  const sistemaAntes = JSON.stringify(chamadas[0].system);
  banco.set('assistenteIA_empresas/mv/estado/atual', { pendencias: ['mudou o estado', 'outra'] });
  banco.set('assistenteIA_empresas/mv/fechamentos/2026-09', { competencia: '09/2026', relatorios: ['extrato', 'diario'] });
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi');
  confere('mudar estado/fechamento NÃO muda o prompt de sistema (cache do histórico preservado)', JSON.stringify(chamadas[1].system) === sistemaAntes);
  confere('o estado novo chega na mensagem atual', ctxAtual(chamadas[1]).includes('mudou o estado') && ctxAtual(chamadas[1]).includes('09/2026'));
  confere('a fala do usuário vem DEPOIS do contexto', chamadas[1].messages[chamadas[1].messages.length - 1].content.slice(-1)[0].text === 'oi');

  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/estado/atual', { pendencias: ['x'] });
  roteiro = [
    resp([uso('atualizar_fechamento', { competencia: '08/2026', pendencias: 2 })], 'tool_use'),
    resp([uso('salvar_observacao', { texto: "regra de teste do contexto" })], 'tool_use'),
    resp([txt('feito')], 'end_turn'),
  ];
  await pedidoComArquivos('segue o extrato', [arquivoPdf('extrato.pdf', PDF_TEXTO)]);
  const ultimoBloco = (c, i) => { const m = c.messages[i === undefined ? c.messages.length - 1 : i]; return Array.isArray(m.content) ? m.content[m.content.length - 1] : null; };
  const primeiraUser = (c) => c.messages.find((m) => m.role === 'user');
  const cc1 = ultimoBloco(chamadas[0]).cache_control;
  confere('com anexo, a mensagem atual já entra no cache na rodada 1 (TTL padrão de 5 min)', cc1 && cc1.type === 'ephemeral' && cc1.ttl === undefined, JSON.stringify(cc1));
  const ultimoDaMsg1 = (c) => { const m = primeiraUser(c); return m.content[m.content.length - 1]; };
  confere('na rodada 2 o marcador sai da mensagem e vai pro último tool_result', !ultimoDaMsg1(chamadas[1]).cache_control && !!ultimoBloco(chamadas[1]).cache_control);
  confere('o contexto da rodada 1 NÃO muda nas rodadas seguintes (prefixo preservado)', [0, 1, 2].every((i) => primeiraUser(chamadas[i]).content[0].text === primeiraUser(chamadas[0]).content[0].text));
  confere('nunca passa de 4 pontos de cache em nenhuma rodada', chamadas.every((c) => (JSON.stringify(c).match(/"cache_control"/g) || []).length <= 4), chamadas.map((c) => (JSON.stringify(c).match(/"cache_control"/g) || []).length).join(','));
  confere('pontos de 1h sempre antes do de 5 min (exigência da API)', chamadas.every((c) => c.system.every((b) => b.cache_control.ttl === '1h')));

  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi curto');
  confere('mensagem pequena sem anexo não paga gravação de cache na rodada 1', !ultimoBloco(chamadas[0]).cache_control);

  const logsCusto = [];
  const logOriginal = console.log;
  console.log = (...a) => { logsCusto.push(a.join(' ')); };
  prepararEmpresa();
  roteiro = [{ content: [txt('ok')], stop_reason: 'end_turn', usage: { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } } }];
  await pedido('custo');
  console.log = logOriginal;
  const linhaTotal = logsCusto.find((l) => l.includes('total da mensagem')) || '';
  confere('log traz o custo estimado em US$ (Sonnet 5.5: 2 + 0,10 + 4 + 1 = 7,10)', linhaTotal.includes('custo estimado US$ 7.1000'), linhaTotal);

  console.log('\n10j) PDF: capa/aviso com logotipo não derrubam a conversão; escaneado continua indo como PDF; cabeçalho repetido sai');
  const imagem = 'q 100 0 0 100 50 500 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q\n';
  const paginaTexto = (n) => txtPdf(50, 700, `Lancamento ${n} - TARIFA BANCARIA COBRADA NO PERIODO`) + txtPdf(50, 680, `Lancamento ${n} - CREDITO DE LIQUIDACAO DE COBRANCA`) + txtPdf(50, 660, `Documento numero ${n} conferido contra o extrato do banco`);
  const relatorio = criarPdf([
    txtPdf(50, 700, 'CAPA DO EXTRATO') + imagem,
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(paginaTexto),
    txtPdf(50, 700, 'AVISO LEGAL') + imagem,
    txtPdf(50, 700, 'OUVIDORIA') + imagem,
  ]);
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('extrato com capa', [arquivoPdf('extrato_capa.pdf', relatorio)]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  const blocoRel = blocosEnviados.find((b) => b.type === 'text' && b.text.includes('PDF convertido em texto'));
  confere('14 páginas com 3 pobres (capa + 2 avisos) = 21%: vira texto, não PDF', !!blocoRel && !blocosEnviados.some((b) => b.type === 'document'));
  confere('o texto das páginas boas veio inteiro', blocoRel && blocoRel.text.includes('Documento numero 7') && blocoRel.text.includes('Lancamento 12'));
  confere('as páginas pobres ganham nota pra IA saber que pode haver conteúdo visual', blocoRel && /\[Página 1: pouco texto e contém imagem/.test(blocoRel.text) && /\[Página 14: pouco texto/.test(blocoRel.text));

  const maioriaEscaneada = criarPdf([txtPdf(50, 700, 'CAPA') + imagem, paginaTexto(2), txtPdf(50, 700, 'FIM') + imagem]);
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('3 páginas, 2 de imagem', [arquivoPdf('misto.pdf', maioriaEscaneada)]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  confere('mais de 30% das páginas pobres com imagem: segue como PDF', blocosEnviados.some((b) => b.type === 'document'));

  const doisPaginas = criarPdf([paginaTexto(1), txtPdf(50, 700, 'COMPROVANTE') + imagem]);
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('comprovante de 2 páginas', [arquivoPdf('curto.pdf', doisPaginas)]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  confere('PDF de 2 páginas com uma pobre + imagem segue como PDF (comprovante escaneado)', blocosEnviados.some((b) => b.type === 'document'));

  const cab = (n) => txtPdf(50, 760, 'EMPRESA TESTE LTDA') + txtPdf(50, 745, 'CNPJ 12.345.678/0001-90') + txtPdf(50, 730, `Folha ${String(n).padStart(4, '0')}`) + txtPdf(50, 715, 'Data Conta Debito Conta Credito Valor');
  const diario = criarPdf([1, 2, 3, 4, 5, 6].map((n) => cab(n) + txtPdf(50, 690, `Lancamento unico numero ${n} com historico bem comprido pra passar do minimo`) + txtPdf(50, 670, `Segundo lancamento da pagina ${n} no valor de ${n}00,00 reais certinhos`)));
  prepararEmpresa();
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedidoComArquivos('diário', [arquivoPdf('diario.pdf', diario)]);
  blocosEnviados = chamadas[0].messages[chamadas[0].messages.length - 1].content;
  const blocoDiario = blocosEnviados.find((b) => b.type === 'text' && b.text.includes('PDF convertido em texto'));
  const ocorr = (txt, trecho) => txt.split(trecho).length - 1;
  confere('cabeçalho idêntico repetido em toda página aparece só uma vez', blocoDiario && ocorr(blocoDiario.text, 'EMPRESA TESTE LTDA') === 1 && ocorr(blocoDiario.text, 'CNPJ 12.345.678/0001-90') === 1 && ocorr(blocoDiario.text, 'Conta Debito') === 1);
  confere('linha que muda por página (Folha) e TODOS os dados ficam', blocoDiario && [1, 2, 3, 4, 5, 6].every((n) => blocoDiario.text.includes(`Folha 000${n}`) && blocoDiario.text.includes(`Lancamento unico numero ${n}`) && blocoDiario.text.includes(`pagina ${n} no valor de ${n}00,00`)));
  confere('avisa a IA que o cabeçalho foi omitido nas páginas seguintes', blocoDiario && blocoDiario.text.includes('foi omitido, vale o da primeira página'));

  console.log('\n10k) planilha: sem linhas vazias nem colunas vazias no fim; print colado não vira documento');
  const PNG = { name: 'image.png', mediaType: 'image/png', base64: Buffer.from('png-falso').toString('base64') };
  const docsNoBanco = () => [...banco.keys()].filter((k) => /\/documentos\/[^/]+$/.test(k)).length;
  prepararEmpresa();
  roteiro = [resp([txt('Vi o erro no print.')], 'end_turn')];
  await pedidoComArquivos('olha esse erro', [PNG]);
  confere('só print colado (image.png): não cria registro em documentos', docsNoBanco() === 0);
  prepararEmpresa();
  roteiro = [resp([txt('Vi.')], 'end_turn')];
  await pedidoComArquivos('foto do boleto', [{ ...PNG, name: 'IMG_2031.jpg', mediaType: 'image/jpeg' }]);
  confere('foto com nome próprio (comprovante) continua sendo guardada', docsNoBanco() === 1);
  prepararEmpresa();
  roteiro = [resp([txt('Preciso da competência.')], 'end_turn')];
  await pedidoComArquivos('segue', [arquivoPdf('extrato.pdf', PDF_TEXTO), PNG]);
  const docMisto = [...banco.entries()].find(([k]) => /\/documentos\/[^/]+$/.test(k));
  confere('PDF + print: guarda só o PDF', docMisto && docMisto[1].arquivos.length === 1 && docMisto[1].arquivos[0] === 'extrato.pdf' && docMisto[1].arquivosInfo.length === 1);
  confere('resposta curta (<300) marca o resumo como parcial', docMisto && docMisto[1].resumoParcial === true);

  prepararEmpresa();
  banco.set('assistenteIA_empresas/mv/documentos/a01', { arquivos: ['curto.pdf'], resumo: 'ok', resumoParcial: true });
  for (let i = 1; i <= 8; i++) banco.set(`assistenteIA_empresas/mv/documentos/d${String(i).padStart(2, '0')}`, { arquivos: [`rel${i}.pdf`], resumo: 'R'.repeat(3000) + `FIM${i}` });
  for (let i = 1; i <= 5; i++) banco.set(`assistenteIA_empresas/mv/documentos/e${String(i).padStart(2, '0')}`, { arquivos: ['image.png'], resumo: 'I'.repeat(3000) + `PRINT${i}` });
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi');
  const promptIdx = chamadas[0].system[1].text;
  const qtdR = (promptIdx.match(/R/g) || []).length;
  confere('prints antigos não roubam as 6 vagas completas: os relatórios mantêm 1500 chars', qtdR >= 6 * 1500 - 200, String(qtdR));
  confere('prints antigos ficam só com o resumo curto', (promptIdx.match(/I/g) || []).length < 5 * 400);
  confere('resumo parcial vem com aviso pra reabrir o arquivo', promptIdx.includes('curto.pdf (resumo curto'));

  console.log('\n10l) consumo: o gasto é gravado ANTES de responder, com nova tentativa se a 1ª falhar');
  prepararEmpresa();
  falhasTransacao = 1;
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('oi');
  const mesCons = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  const consEmp = banco.get(`assistenteIA_empresas/mv/consumo/${mesCons}`);
  const consGeral = banco.get(`assistenteIA_consumoGeral/${mesCons}`);
  confere('consumo da empresa já está gravado quando a resposta volta (mesmo com a 1ª tentativa falhando)', consEmp && consEmp.chamadas === 1 && consEmp.custoUsd > 0, JSON.stringify(consEmp));
  confere('consumo geral do escritório também', consGeral && consGeral.chamadas === 1 && consGeral.custoUsd > 0, JSON.stringify(consGeral));
  confere('percentual de uso fica na empresa', typeof banco.get('assistenteIA_empresas/mv').usoPct === 'number');
  prepararEmpresa();
  roteiro = [
    resp([uso('atualizar_fechamento', { competencia: '08/2026', pendencias: 1 })], 'tool_use'),
    resp([txt('feito')], 'end_turn'),
  ];
  await pedido('duas rodadas');
  const cons2 = banco.get(`assistenteIA_empresas/mv/consumo/${mesCons}`);
  confere('duas chamadas à IA = duas parcelas somadas, nenhuma perdida', cons2 && cons2.chamadas === 2, JSON.stringify(cons2));

  console.log('\n11) busca por nome acha registro com nome duplicado/cortado e devolve o CPF (achado em uso real: Fernanda Cado Waihrich)');
  prepararEmpresa();
  roteiro = [
    resp([uso('verificar_cadastro', { entidades: [{ nome: 'Fernanda Cado Waihrich' }, { nome: 'Fernanda Cado' }] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('acha por palavras mesmo com nome duplicado no cadastro', res.content.includes('52998224725') && !res.content.includes('NÃO encontrados'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere a inquilina');
  const est1 = banco.get('assistenteIA_empresas/mv/estado/atual');
  confere('CPF achado fica guardado no estado da empresa', est1 && est1.entidades && est1.entidades.some((e) => e.cnpj === '52998224725'), JSON.stringify(est1));

  console.log('\n12) arquivo gerado fica guardado e volta no prompt da mensagem seguinte; correção parcial e baixa com título errado avisam');
  const NFS = (n, doc) => ({ cnpj: doc, numeroDocumento: String(n), data: '31/08/2026', acumulador: 1, cfps: 9101, valorServicos: 100 + n });
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'servico_prest', linhas: [NFS(1197, '52998224725'), NFS(1198, '52998224725'), NFS(1199, '52998224725')] })], 'tool_use'),
    resp([txt('feito')], 'end_turn'),
  ];
  await pedido('gera as notas');
  const est2 = banco.get('assistenteIA_empresas/mv/estado/atual');
  confere('linhas do ServicoPrest gravadas no estado', est2.arquivos && est2.arquivos.servico_prest && est2.arquivos.servico_prest.linhas.length === 3);
  chamadas.length = 0;
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'servico_prest', linhas: [NFS(1197, '52998224725')] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('arquivo parcial (1 de 3 linhas) manda a IA regerar completo', res.content.includes('ATENÇÃO') && res.content.includes('INCOMPLETO'), res.content);
      return resp([uso('gerar_arquivo', { tipo: 'baixa_ser', linhas: [{ numero: '1197', cnpj: '52998224725', vencimento: '31/08/2026', databaixa: '02/09/2026', valor: 100 }, { numero: '1218', cnpj: '52998224725', vencimento: '31/08/2026', databaixa: '02/09/2026', valor: 5 }] })], 'tool_use');
    },
    (params) => resp([txt('ok')], 'end_turn'),
  ];
  r = await pedido('corrige a primeira nota');
  const sistemaDaPrimeiraChamada = chamadas[0].system.map((b) => b.text).join('\n') + '\n' + ctxAtual(chamadas[0]);
  confere('prompt da mensagem seguinte traz o estado salvo (CPF e linhas do último arquivo)', sistemaDaPrimeiraChamada.includes('ESTADO SALVO DO TRABALHO') && sistemaDaPrimeiraChamada.includes('52998224725') && sistemaDaPrimeiraChamada.includes('cnpj | numeroDocumento |') && sistemaDaPrimeiraChamada.includes('52998224725 | 1199 |'));
  confere('linhas do estado vão em tabela (sem repetir as chaves em cada linha)', !ctxAtual(chamadas[0]).includes('"numeroDocumento"'));
  confere('estado vai no INÍCIO da mensagem atual, fora do prompt de sistema (não invalida o cache do histórico)', chamadas[0].system.length === 2 && !chamadas[0].system.some((b) => b.text.includes('ESTADO SALVO DO TRABALHO NESTA EMPRESA')) && ctxAtual(chamadas[0]).includes('ESTADO SALVO DO TRABALHO NESTA EMPRESA') && ctxAtual(chamadas[0]).startsWith('[CONTEXTO ATUAL DO SISTEMA'));
  const baixa = r.arquivosGerados.find((a) => a.nome === 'baixa_ser.txt');
  confere('baixa de nota que já existe no Contas a Receber (fora do último ServicoPrest) NÃO gera aviso falso', baixa && baixa.avisos.length === 0, JSON.stringify(baixa && baixa.avisos));

  console.log('\n13) aviso de conferência proíbe a IA de dizer "conferido"');
  roteiro = [
    resp([uso('gerar_arquivo', { tipo: 'servico_prest', linhas: [NFS(1, '11111111111')] })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('resultado da ferramenta diz pra não afirmar que está conferido', res.content.includes('NÃO diga que o arquivo está conferido'), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('gera uma nota com cpf ruim');

  console.log('\n14) salvar_observacao grava na lista da empresa, sem duplicar');
  prepararEmpresa();
  roteiro = [
    resp([uso('salvar_observacao', { texto: 'NFS de aluguel é emitida no CPF do inquilino, com data do último dia do mês anterior ao recebimento' })], 'tool_use'),
    resp([uso('salvar_observacao', { texto: 'nfs de aluguel é emitida no cpf do inquilino, com data do último dia do mês anterior ao recebimento' })], 'tool_use'),
    (params) => {
      const res = params.messages[params.messages.length - 1].content[0];
      confere('segunda igual é reconhecida', res.content.includes('já estava salva'), res.content);
      return resp([txt('anotei')], 'end_turn');
    },
  ];
  await pedido('a nota é no CPF do inquilino');
  const notas = banco.get('assistenteIA_empresas/mv').notas;
  confere('observação gravada uma vez só', notas.length === 1 && notas[0].includes('CPF do inquilino'), JSON.stringify(notas));

  console.log('\n15) lista de pendências é guardada e volta no prompt');
  prepararEmpresa();
  roteiro = [
    resp([uso('atualizar_fechamento', { competencia: '09/2026', listaPendencias: ['14/09 TRANSFERENCIA R$30.000', '15/09 PIX R$803,06'] })], 'tool_use'),
    resp([txt('ok')], 'end_turn'),
  ];
  await pedido('segue');
  chamadas.length = 0;
  roteiro = [resp([txt('ok')], 'end_turn')];
  await pedido('próximo');
  confere('fila de pendências aparece no prompt seguinte', ctxAtual(chamadas[0]).includes('1. 14/09 TRANSFERENCIA R$30.000'));

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
