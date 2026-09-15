const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");
const ExcelJS = require("exceljs");
const { initializeApp: initClientApp } = require("firebase/app");
const { getAuth, signInAnonymously } = require("firebase/auth");
const { getFirestore: getClientFirestore, doc: clientDoc, getDoc: clientGetDoc, collection: clientCollection, query: clientQuery, where, getDocs, limit: clientLimit } = require("firebase/firestore");

initializeApp();
const db = getFirestore();

// Mesmo banco de CNPJ compartilhado usado pelo Baixas-Parcelas e pelo Cadastro de Clientes e
// Fornecedores — projeto separado, autenticação anônima (config já é pública/client-side).
const CIBELE_CONFIG = {
  apiKey: "AIzaSyCBIQkYYNt3K4gZ0OGqoqsU8Jnrsgxif5k",
  authDomain: "conversoes-cibele.firebaseapp.com",
  projectId: "conversoes-cibele",
  storageBucket: "conversoes-cibele.firebasestorage.app",
  messagingSenderId: "401784315449",
  appId: "1:401784315449:web:5d459a524059c0978bb7e8",
};
const cibeleApp = initClientApp(CIBELE_CONFIG, "cibele");
const cibeleAuth = getAuth(cibeleApp);
const cibeleDb = getClientFirestore(cibeleApp);
let cibeleSignInPromise = null;
async function ensureCibeleAuth() {
  if (!cibeleSignInPromise) cibeleSignInPromise = signInAnonymously(cibeleAuth);
  await cibeleSignInPromise;
}

// Verifica se um fornecedor/cliente já existe no cadastro compartilhado (por CNPJ/CPF).
async function lookupEntidade(cnpj) {
  const digits = (cnpj || "").replace(/\D/g, "");
  if (!digits) return null;
  await ensureCibeleAuth();
  const snap = await clientGetDoc(clientDoc(cibeleDb, "clientes", digits));
  return snap.exists() ? snap.data() : null;
}

// Verifica se a empresa atual já está cadastrada no compartilhado (código + CNPJ do Domínio).
async function lookupEmpresa(nomeEmpresa) {
  await ensureCibeleAuth();
  const q = clientQuery(clientCollection(cibeleDb, "empresas_cricon"), where("nome", "==", nomeEmpresa), clientLimit(1));
  const snap = await getDocs(q);
  return snap.empty ? null : snap.docs[0].data();
}

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-sonnet-5";

// Tamanho máximo de cada arquivo anexado, em base64 (~8MB de PDF original).
const MAX_FILE_BASE64_CHARS = 11 * 1024 * 1024;

const TEXT_MEDIA_TYPES = new Set(["text/plain", "text/csv", "application/csv"]);
const SPREADSHEET_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
]);

function cellToString(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.result !== undefined) return cellToString(v.result);
    if (v.text !== undefined) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    return "";
  }
  return String(v);
}

async function xlsxBufferToText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const parts = [];
  workbook.eachSheet((sheet) => {
    parts.push(`--- Planilha: ${sheet.name} ---`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      parts.push(values.map(cellToString).join("\t"));
    });
  });
  return parts.join("\n");
}

// ---------------- geração de arquivo de importação (Domínio) ----------------

// Mesma lógica de formatação de valor já usada nas outras ferramentas do Hub (ex. Bari):
// inteiro sem casas decimais, senão duas casas com vírgula — nunca ponto.
function fmtValorTxt(n) {
  if (n === null || n === undefined || n === "" || isNaN(n)) return "0";
  const r = Math.round(Number(n) * 100) / 100;
  if (r === 0) return "0";
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(".", ",");
}

function stripAccentsJs(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// O Domínio importa em ANSI/Latin-1 — cada caractere fora do intervalo vira "?", igual ao
// downloadTextAnsi() já usado nas outras ferramentas do Hub.
function toLatin1Base64(str) {
  const bytes = Buffer.alloc(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes[i] = code <= 0xff ? code : 0x3f;
  }
  return bytes.toString("base64");
}

const FILE_NAMES = {
  lanctos: "lanctos.txt",
  baixa_ent: "baixa_ent.txt",
  baixa_sai: "baixa_sai.txt",
  baixa_ser: "baixa_ser.txt",
  servico_prest: "ServicoPrest.txt",
};

function buildLanctosLines(linhas) {
  return linhas.map((l) => [
    l.data || "",
    l.debito ?? "",
    l.credito ?? "",
    fmtValorTxt(l.valor),
    l.codHist || "",
    stripAccentsJs(l.complemento || ""),
    l.iniciaLote || "",
    l.codigoEmp || "",
    l.centroCustoDebito || "",
    l.centroCustoCredito || "",
  ].join(";"));
}

function buildBaixaLines(linhas, tipo) {
  return linhas.map((l) => {
    const base = [
      l.numero || "",
      (l.cnpj || "").replace(/\D/g, ""),
      l.vencimento || "",
      l.databaixa || "",
      fmtValorTxt(l.valor),
      fmtValorTxt(l.juros || 0),
      fmtValorTxt(l.multa || 0),
      fmtValorTxt(l.desconto || 0),
    ];
    if (tipo === "baixa_sai" || tipo === "baixa_ser") {
      base.push(
        fmtValorTxt(l.pis || 0),
        fmtValorTxt(l.cofins || 0),
        fmtValorTxt(l.csll || 0),
        fmtValorTxt(l.irrf || 0)
      );
    }
    return base.join(";");
  });
}

function buildServicoPrestLines(linhas) {
  return linhas.map((l) => [
    (l.cnpj || "").replace(/\D/g, ""),
    stripAccentsJs(l.razaoSocial || ""),
    l.uf || "",
    stripAccentsJs(l.municipio || ""),
    stripAccentsJs(l.endereco || ""),
    l.numeroDocumento || "",
    l.serie || "U",
    l.data || "",
    l.situacao ?? 0,
    l.acumulador ?? 1,
    l.cfps ?? 9101,
    fmtValorTxt(l.valorServicos || 0),
    fmtValorTxt(l.valorDescontos || 0),
    l.valorDeducao ?? "",
    fmtValorTxt(l.valorContabil ?? l.valorServicos ?? 0),
    l.baseCalculo ?? "",
    l.aliquotaIss ?? "",
    l.valorIssNormal ?? "",
    l.valorIssRetido ?? "",
    l.valorIrrf ?? "",
    l.valorPis ?? "",
    l.valorCofins ?? "",
    l.valorCsll ?? "",
    l.valorCrf ?? "",
    l.valorInss ?? "",
    l.codigoItem ?? "",
    l.quantidade ?? "",
    l.valorUnitario ?? "",
  ].join(";"));
}

// Monta o arquivo de verdade a partir da tag {{GERAR_ARQUIVO:{...}}} que a IA inclui na
// resposta. Retorna null se a tag não existir ou o tipo não for reconhecido.
function buildArquivoGerado(spec) {
  const nomeArquivo = FILE_NAMES[spec && spec.tipo];
  if (!nomeArquivo || !Array.isArray(spec.linhas) || spec.linhas.length === 0) return null;

  let lines;
  if (spec.tipo === "lanctos") lines = buildLanctosLines(spec.linhas);
  else if (spec.tipo === "baixa_ent" || spec.tipo === "baixa_sai" || spec.tipo === "baixa_ser") {
    lines = buildBaixaLines(spec.linhas, spec.tipo);
  } else if (spec.tipo === "servico_prest") lines = buildServicoPrestLines(spec.linhas);
  else return null;

  const content = lines.join("\r\n") + "\r\n";
  return { nome: nomeArquivo, base64: toLatin1Base64(content), linhas: spec.linhas.length };
}

function buildSystemPrompt(empresaNome, notas, documentos) {
  const notasTexto = (notas || []).length
    ? notas.map((n) => `- ${n}`).join("\n")
    : "(nenhuma observação registrada ainda para esta empresa)";

  const documentosTexto = (documentos || []).length
    ? documentos
        .map((d) => `[${d.dataTexto}] ${d.arquivos.join(", ")}\n${d.resumo}`)
        .join("\n\n")
    : "(nenhum relatório processado ainda para esta empresa)";

  return `Você é o Assistente IA do escritório de contabilidade Cricon, especializado em ler relatórios contábeis e bancários e convertê-los em lançamentos/arquivos prontos para importação no sistema Domínio.

Empresa atual: ${empresaNome}

Observações e padrões já ensinados especificamente para esta empresa:
${notasTexto}

Histórico de relatórios já processados para esta empresa (mais antigos primeiro — use isso pra responder perguntas sobre documentos enviados antes, mesmo que o arquivo original não esteja anexado agora):
${documentosTexto}

Seja direto nas respostas — sem enrolação, sem repetir o que o usuário já disse, sem explicações desnecessárias. Vá direto ao ponto que importa pro contador.

Quando o usuário enviar um relatório (extrato bancário, contas a pagar/receber, aplicação financeira etc.), leia o conteúdo com atenção, aplique as observações acima quando forem relevantes, e responda de forma clara e objetiva em português — sua resposta é guardada como o resumo permanente desse documento, então inclua os detalhes importantes (período do relatório, principais lançamentos, valores, pendências) diretamente nela, não só uma confirmação genérica. Se identificar um padrão novo que valeria a pena guardar como observação permanente desta empresa, sugira isso ao usuário explicitamente (mas nunca grave nada sozinho — quem decide é o usuário). Se precisar de mais informação para prosseguir com segurança, pergunte antes de supor.

MODO DE CONFIGURAÇÃO INICIAL DA EMPRESA: quando o usuário mandar de uma vez o pacote inicial de relatórios de uma empresa nova (tipicamente: Diário, Plano de Contas, extrato bancário e/ou de aplicação, contas a pagar e a receber, ou qualquer combinação parecida), isso significa que ele está configurando essa empresa pela primeira vez — não é um pedido de processamento pontual. Nesse caso:
- NÃO tente adivinhar sozinho como cada lançamento do extrato deve ser tratado.
- Liste os históricos/descrições distintos que aparecem no extrato bancário (agrupando os que são claramente o mesmo tipo de lançamento, ex: todos os "RECEBIMENTO REF. CLIENTES - STONE").
- Pergunte ao usuário, um de cada vez ou em pequenos grupos (não jogue uma lista gigante de uma vez só, isso cansa), como cada tipo deve ser tratado: qual conta débito/crédito usar, se é um lançamento direto ou se deve ser feito por baixa de parcelas (contas a pagar/receber), ou se deve ser ignorado. Siga a ordem descrita em PROCESSO DE CONCILIAÇÃO abaixo antes de perguntar.
- Use o Plano de Contas enviado pra já sugerir a conta mais provável quando fizer sentido, mas sempre confirme com o usuário antes de considerar definitivo — não assuma.
- Depois que o usuário responder sobre um tipo de lançamento, resuma o que entendeu e sugira guardar isso como observação permanente da empresa (a decisão de salvar continua sendo do usuário, nunca automática).
- Esse processo pode levar várias mensagens de ida e volta — está tudo bem, o objetivo aqui é construir o cadastro de padrões da empresa com calma, não entregar tudo pronto na primeira resposta.
- Durante a configuração inicial, pergunte também: (1) a empresa é do regime Lucro Presumido?; (2) é um escritório de advocacia? Guarde as respostas como observação permanente da empresa — isso muda como alguns lançamentos são tratados (aplicação financeira, custas processuais), conforme as seções abaixo.
- Depois que o usuário mandar todos os relatórios iniciais necessários (ou disser que não tem mais nenhum), pergunte exatamente isto: "Existe mais algum relatório que o cliente envia para auxiliar na minha conciliação dos lançamentos?"
- O Cadastro de Fornecedores e Clientes é compartilhado entre TODAS as empresas do escritório (é o mesmo banco usado por outras ferramentas do Hub) — NÃO peça esse relatório por padrão quando receber Contas a Pagar/Receber. Em vez disso, quando processar um relatório de Contas a Pagar ou Contas a Receber, termine sua resposta com uma tag oculta (não explique nem mostre essa tag ao usuário, ela é removida automaticamente): {{CHECK_ENTIDADES:[{"nome":"Nome do fornecedor/cliente","cnpj":"CNPJ ou CPF se aparecer no relatório, senão null"}, ...]}} — liste todos os fornecedores/clientes distintos mencionados. O sistema confere automaticamente contra o cadastro compartilhado e só te avisa (numa próxima mensagem) quais não foram encontrados — só peça informação ao usuário sobre esses que faltaram, nunca peça o relatório inteiro de cadastro de cara.
- O Código e CNPJ da própria empresa também é um dado compartilhado — não peça isso por padrão. O sistema avisa automaticamente se não encontrar a empresa cadastrada.

PROCESSO DE CONCILIAÇÃO (extrato × Contas a Receber/Pagar × Diário) — sempre que tiver o extrato bancário junto com Contas a Receber e/ou Contas a Pagar da mesma empresa (no pacote inicial ou depois), siga esta ordem, do mesmo jeito que já é feito nas outras empresas do escritório:
1. Primeiro, tente ligar automaticamente cada recebimento do extrato a uma ou mais parcelas em aberto do Contas a Receber (por valor e data), e cada pagamento do extrato a uma ou mais parcelas do Contas a Pagar. Preste atenção especial a lançamentos que juntam várias notas fiscais num só valor do extrato (baixa em lote/lançamento composto) — nesse caso, identifique todas as NFs que compõem aquele valor antes de considerar a ligação feita.
2. Antes de perguntar sobre um lançamento do extrato que não bateu com Contas a Pagar/Receber, confira no Diário (no histórico de relatórios já processados) se ele já não foi lançado manualmente antes — se já foi, não pergunte de novo, só confirme que está batendo com o extrato.
3. Para os lançamentos que sobraram depois dos passos 1 e 2 (não bateram com Contas a Pagar/Receber, nem já estavam lançados no Diário), pergunte um por um, seguindo o histórico do extrato, se deve ser lançado manualmente ou baixado de alguma nota fiscal específica que ainda não foi identificada.
4. IMPORTANTE — o Domínio não permite importar baixa de pagamento de Salário, Férias, 13º salário, nem de impostos e encargos trabalhistas. Sempre que aparecer um lançamento desse tipo no extrato, pergunte explicitamente se o usuário prefere fazer o lançamento manual por aqui, ou se prefere dar baixa direto no sistema Domínio (pra evitar diferença no fechamento dos saldos contábeis) — nunca tente gerar baixa automática pra esse tipo de lançamento nem assuma uma resposta.
5. Sempre que houver distribuição de lucros no extrato, pergunte se é um adiantamento ou uma distribuição de fato — nunca assuma. Se for distribuição de fato, pergunte também se o usuário já deseja fazer a provisão desse pagamento.

APLICAÇÃO FINANCEIRA (empresas do Lucro Presumido — confirme nas observações da empresa se ela é desse regime antes de aplicar isso): ao processar o extrato de aplicação financeira, gere a Nota Fiscal de serviço com o valor do rendimento tributado e o IRRF correspondente. Na baixa, use o valor realmente recebido no banco — jogue a diferença entre o valor recebido e o "valor a receber" pra conta de juros.

ESCRITÓRIOS DE ADVOCACIA (confirme nas observações da empresa — mesmo padrão usado em clientes como Gladius, Brogni, Vidal): custas processuais e repasses judiciais que chegarem no extrato sem nota fiscal correspondente devem ficar registrados como pendência (nunca lance às cegas) até aparecer, em qualquer mês futuro, um lançamento que bata por valor com ele. Use o histórico de documentos (relatórios já processados, incluindo de meses anteriores) pra continuar tentando casar essas pendências nos meses seguintes, não só no mês atual.

REGRA DE ARQUIVO DE IMPORTAÇÃO EM TXT: se algum lançamento ficar com a conta débito ou crédito em branco (deve ser raro, já que você pergunta a conta certa na hora), esse lançamento NÃO entra no arquivo de importação em TXT — ele só aparece se o usuário pedir explicitamente uma planilha Excel em vez do TXT.

REVISÃO ANTES DE FECHAR: para todas as empresas (não só as que geram nota fiscal), sempre dê a chance do usuário revisar e confirmar antes de considerar um lançamento, arquivo ou cálculo como definitivo/pronto — nunca finalize algo importante sem essa confirmação.

RELATÓRIOS QUE NÃO SÃO DO BANCO NEM DO DOMÍNIO: alguns clientes exigem gerar um arquivo de importação de Notas Fiscais (padrão do Domínio: NF de serviço prestado, arquivo ServicoPrest.txt) a partir de relatórios próprios do negócio do cliente, que não são extrato bancário nem relatório emitido pelo Domínio — por exemplo, relatório de recibos de aluguel (caso Mantovani) ou relatório de recibos de honorários (caso Bari). Quando o usuário enviar um relatório que não se encaixa em nenhum dos tipos já conhecidos (extrato, Diário, Plano de Contas, Contas a Pagar/Receber, Cadastro de Fornecedores/Clientes), analise o conteúdo pra entender se ele deve virar notas fiscais de serviço a importar. Se ficar em dúvida sobre o que fazer com esse relatório, pergunte ao usuário em vez de supor — nunca invente uma interpretação.

FORMATO EXATO DOS ARQUIVOS DE IMPORTAÇÃO DO DOMÍNIO — confirmados nas ferramentas reais do escritório (não invente campo nem formato fora daqui; se precisar de um tipo de arquivo que não está listado, pergunte ao usuário em vez de supor o layout):

Convenções gerais de todos os TXT: separador ";", quebra de linha CRLF (inclusive na última linha), arquivo em ANSI/Latin-1 (o Domínio desconfigura acentuação — sempre tire acentos dos campos de texto livre no TXT, mas mantenha acentuado numa eventual planilha Excel de conferência). Valor monetário: sem casas decimais quando o valor é inteiro (ex: "1000"), senão 2 casas com vírgula (ex: "1944,18") — nunca ponto decimal. Nome do arquivo é sempre um destes fixos, nunca um nome descritivo:

- Lançamentos → "lanctos.txt". Colunas nesta ordem: Data (DD/MM/AAAA); Débito; Crédito; Valor; Cód. Hist. (geralmente vazio); Complemento/Histórico (sem acento); Inicia Lote ("1" na primeira linha de um lançamento composto, vazio nas linhas seguintes do mesmo lote — só a SOMA do lote precisa fechar Débito=Crédito, não cada linha); Código Emp.; Centro de Custo Débito; Centro de Custo Crédito.
- Baixa de Entradas (fornecedor) → "baixa_ent.txt". Colunas: número do título; CNPJ/CPF (só dígitos); vencimento (DD/MM/AAAA); data da baixa (DD/MM/AAAA); valor pago; juros; multa; desconto.
- Baixa de Saídas e Baixa de Serviços (cliente) → "baixa_sai.txt" / "baixa_ser.txt" (mesmo layout, só muda o nome do arquivo). Colunas: número do título; CNPJ/CPF; vencimento; data da baixa; valor recebido; juros; multa; desconto; PIS; COFINS; CSLL; IRRF.
- Nota Fiscal de Serviço → "ServicoPrest.txt". 28 colunas nesta ordem: CPF/CNPJ; Razão Social; UF; Município; Endereço; Número Documento; Série (use "U"); Data; Situação (0); Acumulador (1); CFPS (9101); Valor Serviços; Valor Descontos; Valor Dedução; Valor Contábil (= Valor Serviços); Base de Cálculo; Alíquota ISS; Valor ISS Normal; Valor ISS Retido; Valor IRRF; Valor PIS; Valor COFINS; Valor CSLL; Valor CRF; Valor INSS; Código do Item; Quantidade; Valor Unitário (as colunas sem valor conhecido ficam vazias, não zero, exceto onde indicado).
- Layout de Nota Fiscal de Entrada e de Saída (mercadoria) ainda não foi confirmado em nenhuma ferramenta do escritório — se precisar gerar um desses, avise o usuário que precisa de um arquivo-modelo antes de montar o layout, nunca invente.
- Movimento bancário direto do extrato (menos comum, layout de largura fixa byte a byte, específico por empresa nos códigos de conta) — a geração automática desse tipo ainda NÃO está disponível (não use a tag {{GERAR_ARQUIVO}} pra esse tipo, ela não vai funcionar); se o usuário pedir esse formato, explique o layout em texto e avise que a geração automática desse tipo específico ainda não foi implementada.

GERAÇÃO DE ARQUIVO PARA IMPORTAR NO DOMÍNIO: depois que os lançamentos de um tipo (Lançamentos, Baixa de Entradas, Baixa de Saídas, Baixa de Serviços, ou Nota Fiscal de Serviço) já estiverem revisados e confirmados pelo usuário, ofereça gerar o arquivo. Termine a mensagem exatamente neste formato, listando só os tipos que você já tem dados prontos e confirmados pra gerar nessa conversa (nunca ofereça um tipo sem ter as linhas prontas):

"Essas são as importações disponíveis até o momento:
1 - [tipo 1]
2 - [tipo 2]
...

Qual delas gostaria de importar primeiro?"

Quando o usuário escolher um (pelo número ou nome), na sua PRÓXIMA resposta: confirme em texto curto (ex: "Aqui está o arquivo, revise antes de importar.") e inclua a tag oculta {{GERAR_ARQUIVO:{...}}} com um objeto JSON válido (não explique nem mostre a tag ao usuário, ela vira um botão de download de verdade automaticamente). Nunca invente uma linha que não foi confirmada na conversa. Formato do objeto, por tipo:

- Lançamentos: {"tipo":"lanctos","linhas":[{"data":"DD/MM/AAAA","debito":"código","credito":"código","valor":0,"codHist":"","complemento":"texto","iniciaLote":"1 ou vazio","codigoEmp":"código","centroCustoDebito":"","centroCustoCredito":""}]}
- Baixa de Entradas: {"tipo":"baixa_ent","linhas":[{"numero":"","cnpj":"","vencimento":"DD/MM/AAAA","databaixa":"DD/MM/AAAA","valor":0,"juros":0,"multa":0,"desconto":0}]}
- Baixa de Saídas: {"tipo":"baixa_sai","linhas":[{"numero":"","cnpj":"","vencimento":"DD/MM/AAAA","databaixa":"DD/MM/AAAA","valor":0,"juros":0,"multa":0,"desconto":0,"pis":0,"cofins":0,"csll":0,"irrf":0}]}
- Baixa de Serviços: mesmo formato de Baixa de Saídas, com "tipo":"baixa_ser"
- Nota Fiscal de Serviço: {"tipo":"servico_prest","linhas":[{"cnpj":"","razaoSocial":"","uf":"","municipio":"","endereco":"","numeroDocumento":"","serie":"U","data":"DD/MM/AAAA","situacao":0,"acumulador":1,"cfps":9101,"valorServicos":0,"valorDescontos":0,"valorContabil":0}]}

Depois de gerar um arquivo, se ainda houver outros tipos pendentes, ofereça a lista de novo (menos o que já foi gerado).

ONDE EMITIR CADA RELATÓRIO NO SISTEMA DOMÍNIO — só explique isso se o usuário perguntar onde emitir, não coloque isso de graça em outras respostas. Diga o caminho em texto, inclua a tag de imagem do caminho, e sempre que houver configurações específicas pra marcar na tela de emissão, explique elas também e inclua a tag de imagem da emissão logo depois (as tags viram prints de tela de verdade antes do usuário ver a mensagem — nunca invente um caminho, configuração ou tag que não esteja nesta lista). Sempre que o relatório pedir um período (Data inicial/final, ou "Posição em"), lembre o usuário de usar o mês que está sendo fechado:
- Diário: Módulo Contábil → Relatórios → Diário {{IMG:diario}}. Na emissão, use o período do mês sendo fechado, marque "Identificação da conta: Código", "Conta crédito e débito na mesma linha", "Destacar linhas" e "Não imprimir a expressão 'Transporte'" {{IMG:diario-emissao}}
- Plano de Contas: Módulo Contábil → Relatórios → Cadastrais → Contas {{IMG:plano-de-contas}}. Na emissão, marque "Destacar contas sintéticas" e "Destacar linhas" {{IMG:plano-de-contas-emissao}}
- Contas a Receber: Módulo Escrita Fiscal → Relatórios → Contas a Pagar e Receber → A Receber {{IMG:contas-a-receber}}. Na emissão, em Situação marque "Aberta/Recebida parcial" e marque "Posição em" com a data final do mês sendo fechado {{IMG:contas-a-receber-emissao}}
- Contas a Pagar: Módulo Escrita Fiscal → Relatórios → Contas a Pagar e Receber → A Pagar {{IMG:contas-a-pagar}}. Na emissão, em Situação marque "Aberta/Paga parcial" e marque "Posição em" com a data final do mês sendo fechado {{IMG:contas-a-pagar-emissao}}
- Cadastro de Fornecedores: Módulo Escrita Fiscal → Relatórios → Cadastrais → Fornecedores {{IMG:cadastro-de-fornecedores}}. Na emissão, Ordem "Código", Modelo "Simples", marque "Destacar linhas" {{IMG:fornecedores-emissao}}
- Cadastro de Clientes: Módulo Escrita Fiscal → Relatórios → Cadastrais → Clientes {{IMG:cadastro-de-clientes}}. Na emissão, as opções padrão (Ordem "Código", Modelo "Completo") já servem {{IMG:clientes-emissao}}
- Código e CNPJ da empresa: em qualquer módulo, Controle → Empresas {{IMG:cnpj-e-codigo}}`;
}

exports.assistenteChat = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    const t0 = Date.now();
    const log = (step) => console.log(`[assistenteChat] ${step} (+${Date.now() - t0}ms)`);
    log("start");
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "É preciso estar logado.");
    }

    const { empresaId, message, history, files } = request.data || {};
    if (!empresaId || typeof empresaId !== "string") {
      throw new HttpsError("invalid-argument", "empresaId é obrigatório.");
    }
    if ((!message || !message.trim()) && (!files || files.length === 0)) {
      throw new HttpsError("invalid-argument", "Envie uma mensagem ou um arquivo.");
    }

    const empresaSnap = await db.collection("assistenteIA_empresas").doc(empresaId).get();
    if (!empresaSnap.exists) {
      throw new HttpsError("not-found", "Empresa não encontrada.");
    }
    const empresa = empresaSnap.data();
    log("empresa carregada");

    // Mesma regra de visibilidade do front: admin vê tudo, os demais só a empresa deles
    // (ou sem responsável ainda). Reforça no backend o que a UI já esconde.
    const ADMIN_EMAILS = ["contabilidadecricon@gmail.com", "guilherme.primetherapy@gmail.com", "rh@cricon.com.br"];
    const userEmail = (request.auth.token.email || "").toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(userEmail);
    const responsavel = (empresa.responsavelEmail || "").toLowerCase();
    if (!isAdmin && responsavel && responsavel !== userEmail) {
      throw new HttpsError("permission-denied", "Você não tem acesso a esta empresa.");
    }

    // Histórico de relatórios já processados — vira contexto permanente da IA, independente
    // do tamanho do chat ou de quando o arquivo original foi enviado.
    const documentosSnap = await db
      .collection("assistenteIA_empresas")
      .doc(empresaId)
      .collection("documentos")
      .orderBy("criadoEm", "asc")
      .limit(200)
      .get();
    const documentos = documentosSnap.docs.map((d) => {
      const data = d.data();
      const dataTexto = data.criadoEm && data.criadoEm.toDate
        ? data.criadoEm.toDate().toLocaleDateString("pt-BR")
        : "";
      return { arquivos: data.arquivos || [], resumo: data.resumo || "", dataTexto };
    });
    log(`histórico de documentos carregado (${documentos.length})`);

    const contentBlocks = [];
    const arquivosNaoLidos = [];
    for (const f of files || []) {
      if (!f.base64 || !f.mediaType || !f.name) continue;
      if (f.base64.length > MAX_FILE_BASE64_CHARS) {
        throw new HttpsError("invalid-argument", `Arquivo "${f.name}" é grande demais.`);
      }
      if (f.mediaType === "application/pdf") {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: f.base64 },
        });
      } else if (f.mediaType.startsWith("image/")) {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: f.mediaType, data: f.base64 },
        });
      } else if (TEXT_MEDIA_TYPES.has(f.mediaType) || f.name.toLowerCase().endsWith(".txt") || f.name.toLowerCase().endsWith(".csv")) {
        const texto = Buffer.from(f.base64, "base64").toString("utf-8");
        contentBlocks.push({ type: "text", text: `--- Conteúdo de ${f.name} ---\n${texto}` });
      } else if (SPREADSHEET_MEDIA_TYPES.has(f.mediaType) || f.name.toLowerCase().endsWith(".xlsx")) {
        try {
          const texto = await xlsxBufferToText(Buffer.from(f.base64, "base64"));
          contentBlocks.push({ type: "text", text: `--- Conteúdo de ${f.name} ---\n${texto}` });
        } catch (err) {
          console.error(`Erro lendo planilha ${f.name}:`, err);
          arquivosNaoLidos.push(f.name);
        }
      } else {
        arquivosNaoLidos.push(f.name);
      }
    }
    if (arquivosNaoLidos.length > 0) {
      contentBlocks.push({
        type: "text",
        text: `(Aviso do sistema: não consegui ler o(s) arquivo(s) ${arquivosNaoLidos.join(", ")} — formato ainda não suportado. Avise o usuário disso explicitamente.)`,
      });
    }
    if (message && message.trim()) {
      contentBlocks.push({ type: "text", text: message.trim() });
    }

    log(`conteúdo montado (${contentBlocks.length} blocos)`);
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const messages = [
      ...(Array.isArray(history) ? history : []).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.text || "",
      })),
      { role: "user", content: contentBlocks },
    ];

    log("chamando a Anthropic API");
    let response;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: buildSystemPrompt(empresa.nome, empresa.notas, documentos),
        messages,
      });
    } catch (err) {
      console.error("Erro chamando a Anthropic API:", err);
      throw new HttpsError("internal", "Erro ao falar com a IA. Tente novamente em instantes.");
    }
    log("resposta da Anthropic recebida");

    let text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    if (!text.trim()) {
      console.error("Resposta da IA veio sem texto. stop_reason:", response.stop_reason, "usage:", JSON.stringify(response.usage));
      text = response.stop_reason === "max_tokens"
        ? "⚠️ O relatório é grande demais — a IA gastou todo o espaço de resposta só pensando, sem sobrar texto. Tenta dividir o pedido em partes menores."
        : "⚠️ A IA não retornou texto dessa vez (sem erro aparente). Tente reformular a pergunta ou tente novamente.";
    }

    // Troca as tags {{IMG:xxx}} que a IA pode ter incluído (só quando explica onde emitir um
    // relatório no Domínio) pelo print de tela de verdade.
    const PATH_IMAGES = {
      "diario": { file: "diario.png", alt: "Caminho do relatório Diário no Domínio" },
      "plano-de-contas": { file: "plano-de-contas.png", alt: "Caminho do Plano de Contas no Domínio" },
      "contas-a-receber": { file: "contas-a-receber.png", alt: "Caminho de Contas a Receber no Domínio" },
      "contas-a-pagar": { file: "contas-a-pagar.png", alt: "Caminho de Contas a Pagar no Domínio" },
      "cadastro-de-fornecedores": { file: "cadastro-de-fornecedores.png", alt: "Caminho do Cadastro de Fornecedores no Domínio" },
      "cadastro-de-clientes": { file: "cadastro-de-clientes.png", alt: "Caminho do Cadastro de Clientes no Domínio" },
      "cnpj-e-codigo": { file: "cnpj-e-codigo.png", alt: "Caminho do Código e CNPJ da empresa no Domínio" },
      "diario-emissao": { file: "diario-emissao.png", alt: "Configurações de emissão do Diário" },
      "plano-de-contas-emissao": { file: "plano-de-contas-emissao.png", alt: "Configurações de emissão do Plano de Contas" },
      "contas-a-receber-emissao": { file: "contas-a-receber-emissao.png", alt: "Configurações de emissão de Contas a Receber" },
      "contas-a-pagar-emissao": { file: "contas-a-pagar-emissao.png", alt: "Configurações de emissão de Contas a Pagar" },
      "fornecedores-emissao": { file: "fornecedores-emissao.png", alt: "Configurações de emissão do Cadastro de Fornecedores" },
      "clientes-emissao": { file: "clientes-emissao.png", alt: "Configurações de emissão do Cadastro de Clientes" },
    };
    text = text.replace(/\{\{IMG:([a-z-]+)\}\}/g, (match, key) => {
      const img = PATH_IMAGES[key];
      if (!img) return "";
      return `\n<img src="assets/caminhos/${img.file}" alt="${img.alt}" style="max-width:100%;border-radius:8px;margin:6px 0;display:block;">`;
    });

    // Confere fornecedores/clientes mencionados (Contas a Pagar/Receber) contra o cadastro
    // compartilhado com o resto do Hub — só avisa o que realmente faltou.
    const checkMatch = text.match(/\{\{CHECK_ENTIDADES:(\[[\s\S]*?\])\}\}/);
    text = text.replace(/\{\{CHECK_ENTIDADES:[\s\S]*?\}\}/, "").trim();
    if (checkMatch) {
      try {
        const entidades = JSON.parse(checkMatch[1]);
        const faltando = [];
        for (const e of entidades) {
          if (!e || !e.nome) continue;
          const encontrado = e.cnpj ? await lookupEntidade(e.cnpj).catch(() => null) : null;
          if (!encontrado) faltando.push(e.nome);
        }

        let empresaEncontrada = null;
        try {
          empresaEncontrada = await lookupEmpresa(empresa.nome);
        } catch (err) {
          console.error("Erro consultando empresa no cadastro compartilhado:", err);
        }

        const avisos = [];
        if (faltando.length > 0) {
          avisos.push(`Não encontrei no cadastro compartilhado: ${faltando.join(", ")}. Pode me passar o CNPJ de cada um, ou mandar o Cadastro de Fornecedores/Clientes (só precisa incluir quem faltou)?`);
        }
        if (!empresaEncontrada) {
          avisos.push(`Também não achei "${empresa.nome}" cadastrada com código/CNPJ no Domínio — pode me passar esses dois dados?`);
        }
        if (avisos.length > 0) {
          text += `\n\n⚠️ ${avisos.join("\n\n⚠️ ")}`;
        }
      } catch (err) {
        console.error("Erro processando CHECK_ENTIDADES:", err, checkMatch[1]);
      }
    }

    // Troca cada tag {{GERAR_ARQUIVO:{...}}} (a IA pode incluir mais de uma na mesma resposta,
    // ex. quando o usuário pede vários arquivos de uma vez) pelo arquivo de importação de
    // verdade, no formato exato que o Domínio aceita. Usa contagem de chaves em vez de regex
    // não-gulosa — não depende da tag estar no fim do texto nem da ordem de outras tags.
    const arquivosGerados = [];
    const MARKER = "{{GERAR_ARQUIVO:";
    let searchFrom = 0;
    while (true) {
      const tagStart = text.indexOf(MARKER, searchFrom);
      if (tagStart === -1) break;
      const jsonStart = tagStart + MARKER.length;
      let depth = 0, jsonEnd = -1;
      for (let i = jsonStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) { jsonEnd = i + 1; break; }
        }
      }
      if (jsonEnd === -1) break; // JSON não fechou (resposta cortada) — para de procurar
      if (text.slice(jsonEnd, jsonEnd + 2) === "}}") {
        const rawJson = text.slice(jsonStart, jsonEnd);
        const fullTag = text.slice(tagStart, jsonEnd + 2);
        text = text.replace(fullTag, "").trim();
        try {
          const spec = JSON.parse(rawJson);
          const arquivo = buildArquivoGerado(spec);
          if (arquivo) arquivosGerados.push(arquivo);
        } catch (err) {
          console.error("Erro processando GERAR_ARQUIVO:", err, rawJson);
        }
        // texto mudou de tamanho (tag removida) — recomeça a busca do zero em vez de usar
        // um índice que não é mais válido
        searchFrom = 0;
      } else {
        searchFrom = jsonEnd; // não era o fechamento certo, continua procurando depois dele
      }
    }

    // Grava a resposta no chat aqui no servidor — não depende do navegador do usuário
    // continuar aberto até a IA terminar (antes disso, se a pessoa atualizasse a página
    // antes da resposta voltar, a resposta nunca era salva, mesmo já pronta).
    await db
      .collection("assistenteIA_empresas")
      .doc(empresaId)
      .collection("mensagens")
      .add({
        role: "assistant",
        text,
        files: [],
        arquivosGerados: arquivosGerados,
        criadoEm: FieldValue.serverTimestamp(),
      });

    // Todo relatório enviado vira uma ficha permanente — é isso que a IA consulta depois,
    // mesmo que o arquivo original não seja reenviado numa pergunta futura.
    const fileNames = (files || []).map((f) => f.name).filter(Boolean);
    if (fileNames.length > 0) {
      await db
        .collection("assistenteIA_empresas")
        .doc(empresaId)
        .collection("documentos")
        .add({
          arquivos: fileNames,
          resumo: text,
          criadoEm: FieldValue.serverTimestamp(),
        });
    }
    log("finalizado");

    return { text, usage: response.usage || null, arquivosGerados };
  }
);
