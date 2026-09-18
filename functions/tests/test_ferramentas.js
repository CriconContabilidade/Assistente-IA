// Roda o handler REAL do functions/index.js com Anthropic e Firestore simulados — testa o laço
// de ferramentas sem gastar com a API e sem tocar no banco de verdade.
const Module = require('module');
const path = require('path');
const ARQ = 'C:/Users/user/Meu Drive/GUILHERME/Claude/GitHub/Assistente-IA/functions/index.js';

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
    return { docs, empty: docs.length === 0, size: docs.length };
  };
  const q = { orderBy: () => q, limit: () => q, get: listar };
  return {
    ...q,
    doc: (id) => docRef(`${caminho}/${id || 'auto' + (++seq)}`),
    async add(dados) { const r = docRef(`${caminho}/auto${++seq}`); await r.set(dados); return r; },
  };
}
const fakeDb = { collection: (n) => colRef(n) };

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
    getFirestore: () => ({}), collection: () => ({}), query: () => ({}),
    where: () => ({}), limit: () => ({}),
    // cadastro compartilhado: só o CNPJ do BB existe. O id vai DENTRO da referência (não numa
    // variável global) pra funcionar certo com consultas em paralelo (Promise.all) — uma
    // variável global compartilhada quebraria sob concorrência real, mesmo o código de
    // produção estando correto (o SDK de verdade do Firestore não tem esse problema).
    doc: (_db, _col, id) => ({ id }),
    getDoc: async (ref) => ({ exists: () => ref.id === '43617343000102', data: () => ({}) }),
    // clientesCompartilhados simula a coleção inteira "clientes" (usada pelo fallback de
    // busca por nome quando não tem CNPJ) — vazia por padrão, um cenário específico enche ela.
    getDocs: async () => ({
      empty: clientesCompartilhados.length === 0,
      docs: clientesCompartilhados.map((c) => ({ data: () => c })),
    }),
  },
};
// Fica valendo pro arquivo inteiro (não só pro cenário 4b) porque verificarCadastro cacheia a
// coleção em memória por alguns minutos (produção: evita rebaixar milhares de docs a cada
// ferramenta chamada na mesma conversa) — setar isso só depois do primeiro uso não teria
// efeito nos testes seguintes, igual não teria numa conversa de verdade.
let clientesCompartilhados = [{ razao_social: 'MONLOTE URBANIZADORA LTDA', documento: '59888185000165', tipo: 'CNPJ' }];
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
const mensagensSalvas = () => [...banco.entries()].filter(([k]) => k.includes('/mensagens/')).map(([, v]) => v);
const LANC = { data: '10/08/2026', debito: '384', credito: '7', valor: 93.1, complemento: 'Tarifa bancaria', codigoEmp: '185' };

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
  confere('ferramentas enviadas na chamada', chamadas[0].tools && chamadas[0].tools.map((t) => t.name).join(',') === 'gerar_arquivo,buscar_arquivo,atualizar_fechamento,verificar_cadastro,consultar_padrao,salvar_padrao', chamadas[0].tools && chamadas[0].tools.map((t) => t.name).join(','));
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
      confere('cadastro aponta quem falta', /NÃO encontrados.*Fornecedor X/.test(res[1].content) && /Encontrados: BB RF/.test(res[1].content), res[1].content);
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
      confere('acha pelo nome mesmo sem CNPJ', /Encontrados: Monlote Urbanizadora/.test(res.content), res.content);
      return resp([txt('ok')], 'end_turn');
    },
  ];
  await pedido('confere fornecedor sem cnpj');

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

  console.log('\n6) tag antiga por hábito ainda funciona e não vaza');
  prepararEmpresa();
  roteiro = [resp([txt('Segue.\n{{GERAR_ARQUIVO:{"tipo":"lanctos","linhas":[{"data":"10/08/2026","debito":"1","credito":"2","valor":5}]}}}\n{{FECHAMENTO:{"competencia":"09/2026","pendencias":0}}}')], 'end_turn')];
  r = await pedido('gera');
  confere('arquivo gerado pela tag', r.arquivosGerados.length === 1);
  confere('nenhuma tag no texto', !r.text.includes('{{'), JSON.stringify(r.text));
  confere('fechamento 09/2026 criado pela tag', !!banco.get('assistenteIA_empresas/mv/fechamentos/2026-09'));

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

  console.log(falhas === 0 ? '\nTUDO OK' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
