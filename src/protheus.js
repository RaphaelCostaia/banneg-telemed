// Cliente do portal de Telemedicina (TOTVS Protheus PLS - Medicar).
// Doc oficial v2.2: https://git-medicar.github.io/api_integracao_beneficiarios/
// Fluxo:
//   1. Token (OAuth2 password)
//   2. Consulta de contrato (BBA_CODINT, CODEMP, CONEMP, VERCON, SUBCON, VERSUB, tenantid)
//   3. Inclusão (PLIncBenModel, operation 3) — gera PROTOCOLO que a Medicar analisa/aprova (PLSA977AB).
//      Nova família = UMA chamada com titular (grau 00) + todos os dependentes no DETAILB2N.
//   4. Bloqueio/Desbloqueio (mesmo endpoint blockProtocol) — age direto, sem aprovação. Por família (matrícula do titular).

const cfg = {
  baseUrl: (process.env.PROTHEUS_BASE_URL || "").replace(/\/$/, ""),
  user: process.env.PROTHEUS_USER || "",
  pass: process.env.PROTHEUS_PASS || "",
  cnpjMedicar: process.env.PROTHEUS_CNPJ_MEDICAR || "",
  grupoEmpresa: process.env.PROTHEUS_GRUPO_EMPRESA || "",
  contrato: process.env.PROTHEUS_CONTRATO || "",
  tenantId: process.env.PROTHEUS_TENANT_ID || "",
  codpro: process.env.PROTHEUS_BBA_CODPRO || "",
  versao: process.env.PROTHEUS_BBA_VERSAO || "001",
  fallback: {
    BBA_CODINT: process.env.PROTHEUS_BBA_CODINT || "",
    BBA_CODEMP: process.env.PROTHEUS_BBA_CODEMP || "",
    BBA_CONEMP: process.env.PROTHEUS_BBA_CONEMP || "",
    BBA_VERCON: process.env.PROTHEUS_BBA_VERCON || "001",
    BBA_SUBCON: process.env.PROTHEUS_BBA_SUBCON || "",
    BBA_VERSUB: process.env.PROTHEUS_BBA_VERSUB || "001",
  },
  dryRun: String(process.env.PROTHEUS_DRY_RUN || "false").toLowerCase() === "true",
  // Bloqueio e desbloqueio usam o MESMO endpoint (diferem por reason/blockDate).
  blockPath: process.env.PROTHEUS_BLOCK_PATH || "/totvsHealthPlans/familyContract/v1/beneficiaries/blockProtocol",
};

export const REASON_DESBLOQUEIO = "000004";

export function protheusConfig() {
  return { baseUrl: cfg.baseUrl, tenantId: cfg.tenantId, dryRun: cfg.dryRun };
}

let tokenCache = { value: null, exp: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.exp > now + 30_000) return tokenCache.value;

  const url =
    `${cfg.baseUrl}/api/oauth2/v1/token?grant_type=password` +
    `&username=${encodeURIComponent(cfg.user)}` +
    `&password=${encodeURIComponent(cfg.pass)}`;

  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || !data.access_token) {
    throw new Error(`Protheus token falhou (HTTP ${res.status}): ${data.raw || JSON.stringify(data)}`);
  }
  const ttl = (data.expires_in ? Number(data.expires_in) : 600) * 1000;
  tokenCache = { value: data.access_token, exp: now + ttl };
  return data.access_token;
}

async function apiFetch(path, { method = "GET", token, tenant, body } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (tenant) headers.tenantId = tenant;
  const res = await fetch(`${cfg.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// Consulta os dados do contrato. Sem cpf -> dados gerais. Com cpf -> dados do beneficiário (BBA_MATRIC, FOUND).
export async function consultarContrato(cpf) {
  const token = await getToken();
  const q = new URLSearchParams({ cnpjmedicar: cfg.cnpjMedicar, grupoempresa: cfg.grupoEmpresa, contrato: cfg.contrato });
  if (cpf) q.set("cgcbeneficiario", cpf);
  const { ok, status, data } = await apiFetch(`/client/v1/contract?${q}`, { token });
  if (!ok) {
    throw new Error(`Consulta de contrato falhou (HTTP ${status}): ${data.msgerror || data.raw || JSON.stringify(data)}`);
  }
  return data;
}

// Recupera a matrícula (BBA_MATRIC) do beneficiário pelo CPF, ou null se ainda não ativo/encontrado.
export async function obterMatricula(cpf) {
  if (cfg.dryRun) return "DRYRUN-MATRIC";
  try {
    const b = await consultarContrato(cpf);
    return b && b.FOUND && b.BBA_MATRIC ? b.BBA_MATRIC : null;
  } catch {
    return null;
  }
}

// ---- Inclusão (PLIncBenModel) ----
function fieldsB2N(b, codpro) {
  const f = [
    { id: "B2N_NOMUSR", value: b.nome },
    { id: "B2N_DATNAS", value: b.nascimento },
    { id: "B2N_GRAUPA", value: b.grau },
    { id: "B2N_ESTCIV", value: b.estciv || "S" },
    { id: "B2N_SEXO", value: b.sexo || "1" },
  ];
  if (b.cpf) f.push({ id: "B2N_CPFUSR", value: b.cpf });
  f.push({ id: "B2N_MAE", value: b.mae || "" });
  if (b.email) f.push({ id: "B2N_EMAIL", value: b.email });
  f.push({ id: "B2N_CODPRO", value: codpro });
  return f;
}

// Corpo genérico do PLIncBenModel (operation 3) com N itens no DETAILB2N.
function bodyPLInc(masterFields, b2nItems) {
  return {
    id: "PLIncBenModel",
    operation: 3,
    models: [
      {
        id: "MASTERBBA",
        modeltype: "FIELDS",
        fields: masterFields,
        models: [
          { id: "DETAILB2N", modeltype: "GRID", items: b2nItems },
          { id: "DETAILANEXO", modeltype: "GRID", items: [{ id: 1, deleted: 0, fields: [] }] },
        ],
      },
    ],
  };
}

// Campos MASTERBBA para inclusão de titular/nova família (ou colaborador PME).
function masterTitular(g, nome, cpf) {
  return [
    { id: "BBA_CODINT", order: 1, value: g("BBA_CODINT") },
    { id: "BBA_CODEMP", order: 2, value: g("BBA_CODEMP") },
    { id: "BBA_CONEMP", order: 3, value: g("BBA_CONEMP") },
    { id: "BBA_VERCON", order: 4, value: g("BBA_VERCON") },
    { id: "BBA_SUBCON", order: 5, value: g("BBA_SUBCON") },
    { id: "BBA_VERSUB", order: 6, value: g("BBA_VERSUB") },
    { id: "BBA_EMPBEN", order: 7, value: nome },
    { id: "BBA_CODPRO", order: 8, value: cfg.codpro },
    { id: "BBA_VERSAO", order: 9, value: cfg.versao },
    { id: "BBA_CPFTIT", order: 10, value: cpf },
  ];
}

// Corpo para incluir um dependente numa família já existente (só BBA_MATRIC no master).
function bodyDependente(matric, dep) {
  return bodyPLInc([{ id: "BBA_MATRIC", order: 1, value: matric }], [
    { id: 1, deleted: 0, fields: fieldsB2N(dep, cfg.codpro) },
  ]);
}

async function incluirBeneficiario(token, body) {
  if (cfg.dryRun) return { ok: true, status: 0, data: { dryRun: true, body } };
  const { ok, status, data } = await apiFetch(`/fwmodel/PLIncBenModel/`, {
    method: "POST", token, tenant: cfg.tenantId, body,
  });
  if (!ok) {
    const msg = data?.errorMessage || data?.message || data?.msgerror || data?.raw || JSON.stringify(data);
    throw new Error(`Inclusão falhou (HTTP ${status}): ${msg}`);
  }
  return { ok, status, data };
}

// ---- Bloqueio / Desbloqueio (mesmo endpoint blockProtocol) ----
async function postBlockProtocol(body) {
  const token = await getToken();
  const { ok, status, data } = await apiFetch(cfg.blockPath, { method: "POST", token, tenant: cfg.tenantId, body });
  if (!ok) {
    const msg = data?.errorMessage || data?.message || data?.msgerror || data?.raw || JSON.stringify(data);
    throw new Error(`blockProtocol falhou (HTTP ${status}): ${msg}`);
  }
  return { ok, data, body };
}

/**
 * Bloqueia um beneficiário (e toda a família). reason = motivo (B9G), blockDate = data da vigência.
 */
export async function bloquearBeneficiario({ subscriberId, reason, blockDate, loginUser }) {
  if (!subscriberId) throw new Error("Beneficiário sem matrícula (BBA_MATRIC) para bloquear.");
  const body = {
    subscriberId,
    reason: reason || "000002",
    blockDate: blockDate || new Date().toISOString().slice(0, 10),
    loginUser: loginUser || "SISTEMA BANNEG",
  };
  if (cfg.dryRun) return { ok: true, dryRun: true, body };
  return postBlockProtocol(body);
}

/**
 * Desbloqueia (reativa) um beneficiário. Mesmo endpoint do bloqueio, com:
 *   reason = "000004"  e  blockDate = (data do bloqueio − 1 dia).
 * @param {object} p { subscriberId, blockDate (data em que foi bloqueado, YYYY-MM-DD), loginUser }
 */
export async function desbloquearBeneficiario({ subscriberId, blockDate, loginUser }) {
  if (!subscriberId) throw new Error("Beneficiário sem matrícula (BBA_MATRIC) para desbloquear.");
  const base = (blockDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const body = {
    subscriberId,
    reason: REASON_DESBLOQUEIO,
    blockDate: d.toISOString().slice(0, 10),
    loginUser: loginUser || "SISTEMA BANNEG",
  };
  if (cfg.dryRun) return { ok: true, dryRun: true, body };
  return postBlockProtocol(body);
}

/**
 * Libera uma venda (pessoa física) no portal — gera protocolo(s) de inclusão.
 * Nova família: UMA chamada com titular (grau 00) + todos os dependentes.
 * Família já existente (titular encontrado): inclui cada dependente pendente.
 * A inclusão é PROTOCOLAR: o cadastro só é efetivado após análise da Medicar; a matrícula vem depois.
 * @returns {{protocolo:boolean, matric:string|null, titularJaExistia:boolean, dependentes:Array, dryRun:boolean}}
 */
export async function liberarVenda(venda, dependentes = []) {
  const token = cfg.dryRun ? "DRYRUN" : await getToken();

  let contrato = {};
  if (!cfg.dryRun) contrato = await consultarContrato();
  const g = (k) => contrato[k] || cfg.fallback[k];

  // Titular já existe? (retentativa / já cadastrado)
  let matric = null, titularJaExistia = false;
  if (!cfg.dryRun) {
    const m = await obterMatricula(venda.titular_cpf);
    if (m) { matric = m; titularJaExistia = true; }
  }

  const depsPend = dependentes.filter((d) => !d.liberado);
  const mapDep = (dep) => ({
    nome: dep.nome, nascimento: dep.nascimento, grau: dep.grau_parentesco,
    estciv: dep.estciv, sexo: dep.sexo, cpf: dep.cpf, mae: dep.mae,
  });

  if (titularJaExistia) {
    // Família existe -> inclui cada dependente pendente (um protocolo cada)
    const resultadosDep = [];
    for (const dep of depsPend) {
      try {
        await incluirBeneficiario(token, bodyDependente(matric, mapDep(dep)));
        resultadosDep.push({ id: dep.id, nome: dep.nome, ok: true });
      } catch (e) {
        resultadosDep.push({ id: dep.id, nome: dep.nome, ok: false, erro: e.message });
      }
    }
    return { protocolo: true, matric, titularJaExistia: true, dependentes: resultadosDep, dryRun: cfg.dryRun };
  }

  // Nova família -> UM protocolo com titular (grau 00) + todos os dependentes
  const items = [
    { id: 1, deleted: 0, fields: fieldsB2N({
      nome: venda.titular_nome, nascimento: venda.titular_nascimento, grau: "00",
      estciv: venda.titular_estciv, sexo: venda.titular_sexo, cpf: venda.titular_cpf,
      mae: venda.titular_mae, email: venda.titular_email,
    }, cfg.codpro) },
  ];
  depsPend.forEach((dep, i) => items.push({ id: i + 2, deleted: 0, fields: fieldsB2N(mapDep(dep), cfg.codpro) }));

  await incluirBeneficiario(token, bodyPLInc(masterTitular(g, venda.titular_nome, venda.titular_cpf), items));

  // Protocolo enviado; matrícula só após aprovação da Medicar.
  const resultadosDep = depsPend.map((d) => ({ id: d.id, nome: d.nome, ok: true }));
  return { protocolo: true, matric: null, titularJaExistia: false, dependentes: resultadosDep, dryRun: cfg.dryRun };
}

/**
 * Libera uma venda de EMPRESA (PME): cada vida (colaborador) é incluída como titular/nova família
 * (um protocolo por vida). A inclusão é protocolar (aguarda análise da Medicar).
 */
export async function liberarEmpresa(venda, vidas = []) {
  const token = cfg.dryRun ? "DRYRUN" : await getToken();
  let contrato = {};
  if (!cfg.dryRun) contrato = await consultarContrato();
  const g = (k) => contrato[k] || cfg.fallback[k];

  const resultados = [];
  for (const v of vidas) {
    if (v.liberado) { resultados.push({ id: v.id, nome: v.nome, ok: true, skip: true }); continue; }
    try {
      const items = [{ id: 1, deleted: 0, fields: fieldsB2N({
        nome: v.nome, nascimento: v.nascimento, grau: "00",
        estciv: v.estciv, sexo: v.sexo, cpf: v.cpf, mae: v.mae, email: v.email,
      }, cfg.codpro) }];
      await incluirBeneficiario(token, bodyPLInc(masterTitular(g, v.nome, v.cpf), items));
      resultados.push({ id: v.id, nome: v.nome, ok: true });
    } catch (e) {
      resultados.push({ id: v.id, nome: v.nome, ok: false, erro: e.message });
    }
  }
  return { protocolo: true, vidas: resultados, dryRun: cfg.dryRun };
}
