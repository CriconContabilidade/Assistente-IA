import { jwtVerify, createRemoteJWKSet } from "jose";

const MODEL = "claude-sonnet-5";
const MAX_FILE_BASE64_CHARS = 11 * 1024 * 1024; // ~8MB de arquivo original
const ADMIN_EMAILS = ["contabilidadecricon@gmail.com", "guilherme.primetherapy@gmail.com", "rh@cricon.com.br"];

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function verifyFirebaseToken(idToken, env) {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID,
  });
  if (!payload.email) throw new Error("Token sem e-mail.");
  return payload;
}

// Lê o documento da empresa no Firestore usando o próprio ID token do usuário como
// credencial — respeita as mesmas regras de segurança (firestore.rules) que o front-end.
async function getEmpresaDoc(empresaId, idToken, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/assistenteIA_empresas/${empresaId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore respondeu ${res.status}`);
  const doc = await res.json();
  return firestoreFieldsToObject(doc.fields || {});
}

function firestoreFieldsToObject(fields) {
  const out = {};
  for (const [key, val] of Object.entries(fields)) {
    out[key] = firestoreValueToJs(val);
  }
  return out;
}
function firestoreValueToJs(val) {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.arrayValue !== undefined) return (val.arrayValue.values || []).map(firestoreValueToJs);
  if (val.mapValue !== undefined) return firestoreFieldsToObject(val.mapValue.fields || {});
  if (val.integerValue !== undefined) return Number(val.integerValue);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  return null;
}

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Método não permitido." }, 405, env);
    }

    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!idToken) return jsonResponse({ error: "Não autenticado." }, 401, env);

    let userPayload;
    try {
      userPayload = await verifyFirebaseToken(idToken, env);
    } catch (err) {
      return jsonResponse({ error: "Token inválido ou expirado." }, 401, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Corpo da requisição inválido." }, 400, env);
    }

    const { empresaId, message, history, files } = body || {};
    if (!empresaId || typeof empresaId !== "string") {
      return jsonResponse({ error: "empresaId é obrigatório." }, 400, env);
    }
    if ((!message || !message.trim()) && (!files || files.length === 0)) {
      return jsonResponse({ error: "Envie uma mensagem ou um arquivo." }, 400, env);
    }

    let empresa;
    try {
      empresa = await getEmpresaDoc(empresaId, idToken, env);
    } catch (err) {
      return jsonResponse({ error: "Erro ao ler a empresa no banco de dados." }, 502, env);
    }
    if (!empresa) return jsonResponse({ error: "Empresa não encontrada." }, 404, env);

    const userEmail = (userPayload.email || "").toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(userEmail);
    const responsavel = (empresa.responsavelEmail || "").toLowerCase();
    if (!isAdmin && responsavel && responsavel !== userEmail) {
      return jsonResponse({ error: "Você não tem acesso a esta empresa." }, 403, env);
    }

    const contentBlocks = [];
    for (const f of files || []) {
      if (!f.base64 || !f.mediaType || !f.name) continue;
      if (f.base64.length > MAX_FILE_BASE64_CHARS) {
        return jsonResponse({ error: `Arquivo "${f.name}" é grande demais.` }, 400, env);
      }
      if (f.mediaType === "application/pdf") {
        contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.base64 } });
      } else if (f.mediaType.startsWith("image/")) {
        contentBlocks.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.base64 } });
      }
    }
    if (message && message.trim()) {
      contentBlocks.push({ type: "text", text: message.trim() });
    }

    const messages = [
      ...(Array.isArray(history) ? history : []).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.text || "",
      })),
      { role: "user", content: contentBlocks },
    ];

    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: buildSystemPrompt(empresa.nome, empresa.notas),
          messages,
        }),
      });
    } catch (err) {
      return jsonResponse({ error: "Erro de rede ao falar com a IA." }, 502, env);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => "");
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return jsonResponse({ error: "Erro ao falar com a IA. Tente novamente em instantes." }, 502, env);
    }

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    return jsonResponse({ text, usage: data.usage || null }, 200, env);
  },
};
