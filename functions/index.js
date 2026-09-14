const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");
const ExcelJS = require("exceljs");

initializeApp();
const db = getFirestore();

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
- Pergunte ao usuário, um de cada vez ou em pequenos grupos (não jogue uma lista gigante de uma vez só, isso cansa), como cada tipo deve ser tratado: qual conta débito/crédito usar, se é um lançamento direto ou se deve ser feito por baixa de parcelas (contas a pagar/receber), ou se deve ser ignorado.
- Use o Plano de Contas enviado pra já sugerir a conta mais provável quando fizer sentido, mas sempre confirme com o usuário antes de considerar definitivo — não assuma.
- Depois que o usuário responder sobre um tipo de lançamento, resuma o que entendeu e sugira guardar isso como observação permanente da empresa (a decisão de salvar continua sendo do usuário, nunca automática).
- Esse processo pode levar várias mensagens de ida e volta — está tudo bem, o objetivo aqui é construir o cadastro de padrões da empresa com calma, não entregar tudo pronto na primeira resposta.`;
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

    return { text, usage: response.usage || null };
  }
);
