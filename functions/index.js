const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MODEL = "claude-sonnet-5";

// Tamanho máximo de cada arquivo anexado, em base64 (~8MB de PDF original).
const MAX_FILE_BASE64_CHARS = 11 * 1024 * 1024;

function buildSystemPrompt(empresaNome, notas) {
  const notasTexto = (notas || []).length
    ? notas.map((n) => `- ${n}`).join("\n")
    : "(nenhuma observação registrada ainda para esta empresa)";

  return `Você é o Assistente IA do escritório de contabilidade Cricon, especializado em ler relatórios contábeis e bancários e convertê-los em lançamentos/arquivos prontos para importação no sistema Domínio.

Empresa atual: ${empresaNome}

Observações e padrões já ensinados especificamente para esta empresa:
${notasTexto}

Quando o usuário enviar um relatório (extrato bancário, contas a pagar/receber, aplicação financeira etc.), leia o conteúdo com atenção, aplique as observações acima quando forem relevantes, e responda de forma clara e objetiva em português. Se identificar um padrão novo que valeria a pena guardar como observação permanente desta empresa, sugira isso ao usuário explicitamente (mas nunca grave nada sozinho — quem decide é o usuário). Se precisar de mais informação para prosseguir com segurança, pergunte antes de supor.`;
}

exports.assistenteChat = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
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

    // Mesma regra de visibilidade do front: admin vê tudo, os demais só a empresa deles
    // (ou sem responsável ainda). Reforça no backend o que a UI já esconde.
    const ADMIN_EMAILS = ["contabilidadecricon@gmail.com", "guilherme.primetherapy@gmail.com", "rh@cricon.com.br"];
    const userEmail = (request.auth.token.email || "").toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(userEmail);
    const responsavel = (empresa.responsavelEmail || "").toLowerCase();
    if (!isAdmin && responsavel && responsavel !== userEmail) {
      throw new HttpsError("permission-denied", "Você não tem acesso a esta empresa.");
    }

    const contentBlocks = [];
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
      }
    }
    if (message && message.trim()) {
      contentBlocks.push({ type: "text", text: message.trim() });
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const messages = [
      ...(Array.isArray(history) ? history : []).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.text || "",
      })),
      { role: "user", content: contentBlocks },
    ];

    let response;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: buildSystemPrompt(empresa.nome, empresa.notas),
        messages,
      });
    } catch (err) {
      console.error("Erro chamando a Anthropic API:", err);
      throw new HttpsError("internal", "Erro ao falar com a IA. Tente novamente em instantes.");
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    return { text, usage: response.usage || null };
  }
);
