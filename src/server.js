import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { db, logEvento } from "./db.js";
import { asaas } from "./asaas.js";
import { liberarVenda, liberarEmpresa, bloquearBeneficiario, desbloquearBeneficiario, obterMatricula, protheusConfig } from "./protheus.js";
import { PLANOS, getPlano, calcularValor, calcularValorEmpresa, precoPorVidaPME, FAIXAS_PME, PME_LIMITE_COTACAO, FORMAS_PAGAMENTO, GRAUS_PARENTESCO, ESTADOS_CIVIS, SEXOS, BILLING_TYPES, MOTIVOS_BLOQUEIO, validarNomeANS } from "./planos.js";
import { seedAdmin, autenticar, criarSessao, obterSessao, destruirSessao, parseCookies, verificarApiKey } from "./auth.js";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";

const AUTO_BLOQUEAR_VENCIDO = String(process.env.AUTO_BLOQUEAR_VENCIDO || "false").toLowerCase() === "true";
const SYNC_MIN = Number(process.env.ASAAS_SYNC_MINUTES || 5);
let ultimaSync = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const app = express();
app.use(express.json({ limit: "1mb" }));

seedAdmin();

// ---- autenticação: sessão via cookie httpOnly ----
const CAMINHOS_PUBLICOS = new Set([
  "/login.html", "/styles.css", "/favicon.ico",
  "/api/login", "/api/logout", "/api/health", "/webhooks/asaas",
]);

app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  if (CAMINHOS_PUBLICOS.has(req.path)) return next();

  // Integração máquina-a-máquina (N8N) via chave de API
  if (verificarApiKey(req)) {
    req.usuario = { nome: "N8N", login: "n8n", papel: "integracao" };
    return next();
  }

  const sess = obterSessao(req.cookies.sid);
  if (!sess) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ erro: "não autenticado" });
    return res.redirect("/login.html");
  }
  req.usuario = sess;
  next();
});

// rotas de sessão
app.post("/api/login", (req, res) => {
  const u = autenticar(req.body?.login, req.body?.senha);
  if (!u) return res.status(401).json({ erro: "Usuário ou senha inválidos." });
  const token = criarSessao(u);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`);
  logEvento("login", u.login, { papel: u.papel });
  res.json({ ok: true, nome: u.nome, papel: u.papel });
});

app.post("/api/logout", (req, res) => {
  destruirSessao(req.cookies?.sid);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json({ nome: req.usuario.nome, login: req.usuario.login, papel: req.usuario.papel }));

app.use(express.static(publicDir));

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const toYmd = (s) => String(s || "").replace(/-/g, ""); // 2024-01-31 -> 20240131

// ---- mapeamento de status Asaas -> status interno ----
function mapPagamento(asaasStatus) {
  switch (asaasStatus) {
    case "CONFIRMED":
      return "confirmado";
    case "RECEIVED":
    case "RECEIVED_IN_CASH":
      return "recebido";
    case "OVERDUE":
      return "vencido";
    case "REFUNDED":
    case "REFUND_REQUESTED":
      return "estornado";
    default:
      return "aguardando";
  }
}
const PAGO = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"]);

// ---- consultas reutilizáveis ----
const qVenda = db.prepare("SELECT * FROM vendas WHERE id = ?");
const qDeps = db.prepare("SELECT * FROM dependentes WHERE venda_id = ? ORDER BY id");
const touchVenda = db.prepare("UPDATE vendas SET updated_at = datetime('now') WHERE id = ?");

// =====================================================================
//  Metadados (planos e domínios) para o front-end
// =====================================================================
app.get("/api/meta", (req, res) => {
  res.json({
    planos: PLANOS,
    formasPagamento: FORMAS_PAGAMENTO,
    pme: { faixas: FAIXAS_PME, limiteCotacao: PME_LIMITE_COTACAO },
    graus: GRAUS_PARENTESCO,
    estadosCivis: ESTADOS_CIVIS,
    sexos: SEXOS,
    billingTypes: BILLING_TYPES,
    motivosBloqueio: MOTIVOS_BLOQUEIO,
    asaasConfigurado: asaas.configured,
    protheus: protheusConfig(),
    autoBloquearVencido: AUTO_BLOQUEAR_VENCIDO,
    ultimaSync,
    syncIntervaloMin: SYNC_MIN,
  });
});

// =====================================================================
//  Nova venda: cria cliente + assinatura no Asaas e registra localmente
// =====================================================================
app.post("/api/vendas", async (req, res) => {
  // vendas de empresa (PME) seguem outro fluxo
  if (req.body?.tipo_plano === "empresa" || req.body?.tipo_pessoa === "juridica") {
    return criarVendaEmpresa(req, res);
  }
  try {
    const b = req.body || {};
    const plano = getPlano(b.tipo_plano);
    if (!plano) return res.status(400).json({ erro: "Plano inválido." });

    const titular = b.titular || {};
    if (!titular.nome || !onlyDigits(titular.cpf)) {
      return res.status(400).json({ erro: "Informe nome e CPF do titular." });
    }

    const dependentes = Array.isArray(b.dependentes) ? b.dependentes : [];
    if (dependentes.length > plano.maxDependentes) {
      return res.status(400).json({
        erro: `O plano ${plano.nome} permite no máximo ${plano.maxDependentes} dependente(s).`,
      });
    }

    // Validação de nome (padrão ANS) — reduz rejeição do protocolo na Medicar
    const errNome = validarNomeANS(titular.nome);
    if (errNome) return res.status(400).json({ erro: `Titular: ${errNome}` });
    for (const d of dependentes) {
      const e = validarNomeANS(d.nome);
      if (e) return res.status(400).json({ erro: `Dependente "${d.nome || ""}": ${e}` });
    }

    // Idempotência: mesma venda (mesmo externalId do N8N) não é criada duas vezes
    const externalId = (b.externalId || "").toString().trim() || null;
    if (externalId) {
      const ex = db.prepare("SELECT * FROM vendas WHERE external_id=?").get(externalId);
      if (ex) {
        return res.json({
          ok: true, jaExistia: true, venda_id: ex.id, externalId,
          paymentLink: ex.primeira_cobranca_url, valor: ex.valor, status_pagamento: ex.status_pagamento,
        });
      }
    }

    // Formas aceitas: apenas PIX e cartão de crédito
    const billingType = ["PIX", "CREDIT_CARD"].includes(b.billingType) ? b.billingType : "PIX";

    // Valor calculado no servidor (nunca confia no cliente): forma de pagamento + nº de vidas
    const qtdVidas = 1 + dependentes.length;
    const valor = calcularValor(plano.id, billingType, qtdVidas);
    if (valor == null) {
      return res.status(400).json({ erro: "Não foi possível calcular o valor para este plano/forma de pagamento." });
    }

    // 1) grava a venda (rascunho) para obter o id
    const info = db
      .prepare(
        `INSERT INTO vendas
         (tipo_plano, valor, billing_type, titular_nome, titular_cpf, titular_nascimento,
          titular_sexo, titular_estciv, titular_mae, titular_email, titular_ddd, titular_telefone, vendedor, external_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        plano.id,
        valor,
        billingType,
        titular.nome.trim(),
        onlyDigits(titular.cpf),
        toYmd(titular.nascimento),
        titular.sexo || null,
        titular.estciv || null,
        titular.mae || null,
        titular.email || null,
        onlyDigits(titular.ddd) || null,
        onlyDigits(titular.telefone) || null,
        b.vendedor || req.usuario?.nome || null,
        externalId
      );
    const vendaId = Number(info.lastInsertRowid);

    const insDep = db.prepare(
      `INSERT INTO dependentes (venda_id, nome, cpf, nascimento, sexo, estciv, grau_parentesco, mae)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const d of dependentes) {
      insDep.run(
        vendaId,
        (d.nome || "").trim(),
        onlyDigits(d.cpf) || null,
        toYmd(d.nascimento),
        d.sexo || null,
        d.estciv || null,
        d.grau || "11",
        d.mae || null
      );
    }

    // 2) Asaas: cliente + assinatura recorrente
    const mobile = titular.ddd && titular.telefone ? onlyDigits(titular.ddd) + onlyDigits(titular.telefone) : undefined;
    const customer = await asaas.createCustomer({
      name: titular.nome.trim(),
      cpfCnpj: onlyDigits(titular.cpf),
      email: titular.email,
      mobilePhone: mobile,
      externalReference: `venda:${vendaId}`,
    });

    const hoje = new Date();
    const nextDueDate = hoje.toISOString().slice(0, 10); // primeira cobrança hoje

    const subscription = await asaas.createSubscription({
      customer: customer.id,
      billingType,
      value: valor,
      nextDueDate,
      cycle: "MONTHLY",
      description: `Banneg Telemedicina - ${plano.nome} (${qtdVidas} vida${qtdVidas > 1 ? "s" : ""})`,
      externalReference: `venda:${vendaId}`,
    });

    // 3) busca a primeira cobrança para pegar o link de pagamento (e o Pix copia-e-cola)
    let invoiceUrl = null, pixCopiaECola = null;
    try {
      const pays = await asaas.getSubscriptionPayments(subscription.id);
      const first = pays?.data?.[0];
      if (first) {
        invoiceUrl = first.invoiceUrl || null;
        upsertCobranca(first, vendaId);
        if (billingType === "PIX") {
          try { const qr = await asaas.getPixQrCode(first.id); pixCopiaECola = qr?.payload || null; } catch { /* opcional */ }
        }
      }
    } catch (e) {
      logEvento("asaas_payments_erro", vendaId, { erro: e.message });
    }

    db.prepare(
      `UPDATE vendas SET asaas_customer_id=?, asaas_subscription_id=?, primeira_cobranca_url=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(customer.id, subscription.id, invoiceUrl, vendaId);

    logEvento("venda_criada", vendaId, { customer: customer.id, subscription: subscription.id, externalId });

    res.json({ ok: true, venda_id: vendaId, externalId, paymentLink: invoiceUrl, pixCopiaECola, valor, customer: customer.id, subscription: subscription.id });
  } catch (e) {
    console.error("Erro ao criar venda:", e);
    res.status(500).json({ erro: e.message });
  }
});

// =====================================================================
//  Nova venda EMPRESA (PME): CNPJ + lista de vidas, preço por faixa
// =====================================================================
async function criarVendaEmpresa(req, res) {
  try {
    const b = req.body || {};
    const empresa = b.empresa || {};
    const razao = (empresa.razao_social || "").trim();
    const cnpj = onlyDigits(empresa.cnpj);
    if (!razao || cnpj.length !== 14) {
      return res.status(400).json({ erro: "Informe a razão social e um CNPJ válido (14 dígitos)." });
    }

    const vidas = (Array.isArray(b.vidas) ? b.vidas : []).filter((v) => v && (v.nome || "").trim());
    if (!vidas.length) return res.status(400).json({ erro: "Adicione ao menos uma vida (colaborador)." });

    // Validação de nome (padrão ANS) de cada vida
    for (const v of vidas) {
      const e = validarNomeANS(v.nome);
      if (e) return res.status(400).json({ erro: `Vida "${v.nome || ""}": ${e}` });
    }

    // Idempotência por externalId
    const externalId = (b.externalId || "").toString().trim() || null;
    if (externalId) {
      const ex = db.prepare("SELECT * FROM vendas WHERE external_id=?").get(externalId);
      if (ex) {
        return res.json({
          ok: true, jaExistia: true, venda_id: ex.id, externalId,
          paymentLink: ex.primeira_cobranca_url, valor: ex.valor, status_pagamento: ex.status_pagamento,
        });
      }
    }

    const billingType = ["PIX", "CREDIT_CARD"].includes(b.billingType) ? b.billingType : "PIX";
    const qtdVidas = vidas.length;
    const porVida = precoPorVidaPME(qtdVidas);
    const cotacao = porVida == null; // acima de 100 vidas
    const valor = cotacao ? 0 : calcularValorEmpresa(qtdVidas);

    // grava a venda
    const info = db.prepare(
      `INSERT INTO vendas
        (tipo_plano, tipo_pessoa, valor, billing_type, titular_nome, titular_cpf,
         razao_social, cnpj, qtd_vidas, titular_email, titular_ddd, titular_telefone,
         status_pagamento, vendedor, external_id)
       VALUES ('empresa','juridica',?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      valor, billingType, razao, cnpj, razao, cnpj, qtdVidas,
      empresa.email || null, onlyDigits(empresa.ddd) || null, onlyDigits(empresa.telefone) || null,
      cotacao ? "cotacao" : "aguardando",
      b.vendedor || req.usuario?.nome || null,
      externalId
    );
    const vendaId = Number(info.lastInsertRowid);

    const insVida = db.prepare(
      `INSERT INTO dependentes (venda_id, nome, cpf, nascimento, sexo, estciv, grau_parentesco, mae)
       VALUES (?,?,?,?,?,?, '00', ?)`
    );
    for (const v of vidas) {
      insVida.run(vendaId, (v.nome || "").trim(), onlyDigits(v.cpf) || null, toYmd(v.nascimento),
        v.sexo || null, v.estciv || null, v.mae || null);
    }

    // acima de 100 vidas: sem cobrança automática — encaminhar ao consultor
    if (cotacao) {
      logEvento("venda_empresa_cotacao", vendaId, { qtdVidas, razao });
      return res.json({
        ok: true, venda_id: vendaId, externalId, cotacao: true, qtdVidas,
        mensagem: `Acima de ${PME_LIMITE_COTACAO} vidas: encaminhe ao consultor para cotação. A venda foi registrada sem cobrança.`,
      });
    }

    // Asaas: cliente PJ + assinatura
    const mobile = empresa.ddd && empresa.telefone ? onlyDigits(empresa.ddd) + onlyDigits(empresa.telefone) : undefined;
    const customer = await asaas.createCustomer({
      name: razao, cpfCnpj: cnpj, company: razao, email: empresa.email, mobilePhone: mobile,
      externalReference: `venda:${vendaId}`,
    });
    const nextDueDate = new Date().toISOString().slice(0, 10);
    const subscription = await asaas.createSubscription({
      customer: customer.id, billingType, value: valor, nextDueDate, cycle: "MONTHLY",
      description: `Banneg Telemedicina - Empresa (${qtdVidas} vidas)`,
      externalReference: `venda:${vendaId}`,
    });

    let invoiceUrl = null, pixCopiaECola = null;
    try {
      const pays = await asaas.getSubscriptionPayments(subscription.id);
      const first = pays?.data?.[0];
      if (first) {
        invoiceUrl = first.invoiceUrl || null;
        upsertCobranca(first, vendaId);
        if (billingType === "PIX") {
          try { const qr = await asaas.getPixQrCode(first.id); pixCopiaECola = qr?.payload || null; } catch { /* opcional */ }
        }
      }
    } catch (e) { logEvento("asaas_payments_erro", vendaId, { erro: e.message }); }

    db.prepare(
      `UPDATE vendas SET asaas_customer_id=?, asaas_subscription_id=?, primeira_cobranca_url=?, updated_at=datetime('now') WHERE id=?`
    ).run(customer.id, subscription.id, invoiceUrl, vendaId);

    logEvento("venda_empresa_criada", vendaId, { customer: customer.id, subscription: subscription.id, qtdVidas, porVida, valor, externalId });
    res.json({ ok: true, venda_id: vendaId, externalId, paymentLink: invoiceUrl, pixCopiaECola, customer: customer.id, subscription: subscription.id, qtdVidas, porVida, valor });
  } catch (e) {
    console.error("Erro ao criar venda de empresa:", e);
    res.status(500).json({ erro: e.message });
  }
}

// upsert de cobrança a partir do objeto payment do Asaas
const insCobranca = db.prepare(
  `INSERT INTO cobrancas (venda_id, asaas_payment_id, value, status, billing_type, due_date, payment_date, invoice_url)
   VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(asaas_payment_id) DO UPDATE SET
     status=excluded.status, value=excluded.value, billing_type=excluded.billing_type,
     due_date=excluded.due_date, payment_date=excluded.payment_date,
     invoice_url=excluded.invoice_url, updated_at=datetime('now')`
);
function upsertCobranca(p, vendaId) {
  insCobranca.run(
    vendaId ?? null,
    p.id,
    p.value ?? null,
    p.status ?? null,
    p.billingType ?? null,
    p.dueDate ?? null,
    p.paymentDate || p.clientPaymentDate || null,
    p.invoiceUrl ?? null
  );
}

// Callback para o N8N (fire-and-forget) a cada mudança relevante da venda.
async function notificarN8N(venda, evento, extra = {}) {
  if (!N8N_WEBHOOK_URL || !venda) return;
  const pf = venda.tipo_pessoa !== "juridica";
  const acesso = pf
    ? {
        portal: "Telemedicina Medicar (app ou site)",
        login: venda.titular_cpf,
        senhaInicial: venda.titular_cpf,
        instrucao: "No primeiro acesso use o CPF (só números) como login e senha; depois cadastre uma nova senha.",
      }
    : {
        portal: "Telemedicina Medicar (app ou site)",
        instrucao: "Cada colaborador acessa com o próprio CPF (só números) como login e senha no primeiro acesso.",
      };
  const payload = {
    evento,
    venda_id: venda.id,
    externalId: venda.external_id || null,
    tipo_pessoa: venda.tipo_pessoa,
    tipo_plano: venda.tipo_plano,
    titular_nome: venda.titular_nome,
    razao_social: venda.razao_social || null,
    documento: pf ? venda.titular_cpf : venda.cnpj,
    email: venda.titular_email || null,
    valor: venda.valor,
    status_pagamento: venda.status_pagamento,
    status_liberacao: venda.status_liberacao,
    protheus_matric: venda.protheus_matric || null,
    acesso,
    ...extra,
    ts: new Date().toISOString(),
  };
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    logEvento("n8n_callback", venda.id, { evento });
  } catch (e) {
    logEvento("n8n_callback_erro", venda.id, { evento, erro: e.message });
  }
}

// =====================================================================
//  Listagens e dashboard
// =====================================================================
app.get("/api/vendas", (req, res) => {
  const vendas = db
    .prepare(
      `SELECT v.*,
        (SELECT COUNT(*) FROM dependentes d WHERE d.venda_id=v.id) AS qtd_dependentes
       FROM vendas v ORDER BY v.id DESC`
    )
    .all();
  res.json(vendas);
});

app.get("/api/vendas/:id", (req, res) => {
  const venda = qVenda.get(Number(req.params.id));
  if (!venda) return res.status(404).json({ erro: "Venda não encontrada." });
  const dependentes = qDeps.all(venda.id);
  const cobrancas = db.prepare("SELECT * FROM cobrancas WHERE venda_id=? ORDER BY id DESC").all(venda.id);
  res.json({ ...venda, dependentes, cobrancas });
});

app.get("/api/cobrancas", (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, v.titular_nome, v.tipo_plano
       FROM cobrancas c LEFT JOIN vendas v ON v.id=c.venda_id
       ORDER BY c.due_date DESC, c.id DESC LIMIT 500`
    )
    .all();
  res.json(rows);
});

app.get("/api/dashboard", (req, res) => {
  const num = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  const val = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  const hoje = new Date().toISOString().slice(0, 10);
  const mesAtual = hoje.slice(0, 7); // YYYY-MM

  // período (padrão: mês atual)
  const de = (req.query.de || `${mesAtual}-01`).slice(0, 10);
  const ate = (req.query.ate || hoje).slice(0, 10);

  const vendasNoPeriodo = num("SELECT COUNT(*) n FROM vendas WHERE date(created_at) BETWEEN ? AND ?", de, ate);
  const recebidoNoPeriodo = val(
    `SELECT COALESCE(SUM(value),0) n FROM cobrancas
     WHERE status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')
       AND date(COALESCE(payment_date, due_date)) BETWEEN ? AND ?`, de, ate);
  const canceladosNoPeriodo = num(
    "SELECT COUNT(*) n FROM vendas WHERE assinatura_cancelada_em BETWEEN ? AND ?", de, ate);
  const ticketMedio = vendasNoPeriodo
    ? Number((val("SELECT COALESCE(AVG(valor),0) n FROM vendas WHERE date(created_at) BETWEEN ? AND ?", de, ate)).toFixed(2))
    : 0;

  const totalVendas = num("SELECT COUNT(*) n FROM vendas");
  const assinaturasAtivas = num(
    "SELECT COUNT(*) n FROM vendas WHERE asaas_subscription_id IS NOT NULL AND assinatura_status='ativa' AND bloqueado=0"
  );
  const mrr =
    db.prepare(
      "SELECT COALESCE(SUM(valor),0) n FROM vendas WHERE asaas_subscription_id IS NOT NULL AND assinatura_status='ativa' AND bloqueado=0"
    ).get()?.n ?? 0;

  const recebidoMes =
    db
      .prepare(
        `SELECT COALESCE(SUM(value),0) n FROM cobrancas
         WHERE status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')
           AND substr(COALESCE(payment_date, due_date),1,7)=?`
      )
      .get(mesAtual)?.n ?? 0;

  const cobrancasPendentes = num(
    "SELECT COUNT(*) n FROM cobrancas WHERE status IN ('PENDING','AWAITING_RISK_ANALYSIS')"
  );
  const cobrancasVencidas = num("SELECT COUNT(*) n FROM cobrancas WHERE status='OVERDUE'");
  const cobrancasPagas = num(
    "SELECT COUNT(*) n FROM cobrancas WHERE status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')"
  );

  const liberacoesPendentes = num(
    "SELECT COUNT(*) n FROM vendas WHERE status_pagamento IN ('confirmado','recebido') AND status_liberacao!='liberado'"
  );
  const liberados = num("SELECT COUNT(*) n FROM vendas WHERE status_liberacao='liberado'");
  const errosLiberacao = num("SELECT COUNT(*) n FROM vendas WHERE status_liberacao='erro'");

  const porPlano = db
    .prepare("SELECT tipo_plano, COUNT(*) n FROM vendas GROUP BY tipo_plano")
    .all();

  res.json({
    totalVendas,
    assinaturasAtivas,
    mrr,
    recebidoMes,
    cobrancasPendentes,
    cobrancasVencidas,
    cobrancasPagas,
    liberacoesPendentes,
    liberados,
    errosLiberacao,
    porPlano,
    periodo: { de, ate, vendasNoPeriodo, recebidoNoPeriodo, canceladosNoPeriodo, ticketMedio },
  });
});

// =====================================================================
//  Liberação no portal de telemedicina (Protheus)
// =====================================================================
async function executarLiberacaoEmpresa(venda, origem) {
  const vidas = qDeps.all(venda.id);
  try {
    const r = await liberarEmpresa(venda, vidas);
    const okDep = db.prepare("UPDATE dependentes SET liberado=1, protheus_erro=NULL WHERE id=?");
    const errDep = db.prepare("UPDATE dependentes SET protheus_erro=? WHERE id=?");
    let todos = true;
    for (const v of r.vidas) {
      if (v.ok) okDep.run(v.id);
      else { errDep.run(v.erro, v.id); todos = false; }
    }
    db.prepare(
      "UPDATE vendas SET status_liberacao=?, liberacao_erro=?, updated_at=datetime('now') WHERE id=?"
    ).run(todos ? "liberado" : "erro", todos ? null : "Falha ao liberar uma ou mais vidas.", venda.id);
    logEvento("liberacao_empresa", venda.id, { origem, ...r });
    await notificarN8N(
      qVenda.get(venda.id),
      todos ? "cadastro_enviado" : "erro_liberacao",
      todos
        ? { protocolo: true, vidas: r.vidas.length, obs: "Colaboradores enviados à Medicar; acesso liberado após aprovação." }
        : { erro: "Falha ao enviar o cadastro de uma ou mais vidas." }
    );
    return { ok: todos, dryRun: r.dryRun, vidas: r.vidas };
  } catch (e) {
    db.prepare("UPDATE vendas SET status_liberacao='erro', liberacao_erro=?, updated_at=datetime('now') WHERE id=?").run(e.message, venda.id);
    logEvento("liberacao_empresa_erro", venda.id, { origem, erro: e.message });
    await notificarN8N(qVenda.get(venda.id), "erro_liberacao", { erro: e.message });
    throw e;
  }
}

async function executarLiberacao(vendaId, origem) {
  const venda = qVenda.get(vendaId);
  if (!venda) throw new Error("Venda não encontrada.");
  if (venda.status_liberacao === "liberado") {
    return { jaLiberado: true, matric: venda.protheus_matric };
  }
  if (venda.tipo_pessoa === "juridica") return executarLiberacaoEmpresa(venda, origem);
  const dependentes = qDeps.all(vendaId);

  try {
    const r = await liberarVenda(venda, dependentes);

    // marca dependentes liberados
    const okDep = db.prepare("UPDATE dependentes SET liberado=1, protheus_erro=NULL WHERE id=?");
    const errDep = db.prepare("UPDATE dependentes SET protheus_erro=? WHERE id=?");
    let todosDeps = true;
    for (const d of r.dependentes) {
      if (d.ok) okDep.run(d.id);
      else {
        errDep.run(d.erro, d.id);
        todosDeps = false;
      }
    }

    const status = todosDeps ? "liberado" : "erro";
    const erro = todosDeps ? null : "Falha ao liberar um ou mais dependentes.";
    db.prepare(
      "UPDATE vendas SET status_liberacao=?, protheus_matric=?, liberacao_erro=?, updated_at=datetime('now') WHERE id=?"
    ).run(status, r.matric || null, erro, vendaId);

    logEvento("liberacao", vendaId, { origem, ...r });
    await notificarN8N(
      qVenda.get(vendaId),
      todosDeps ? "cadastro_enviado" : "erro_liberacao",
      todosDeps
        ? { protocolo: true, obs: "Cadastro enviado à Medicar; acesso liberado após aprovação (geralmente em até 1 dia útil)." }
        : { erro: "Falha ao enviar o cadastro de um ou mais beneficiários." }
    );
    return { ok: todosDeps, matric: r.matric, dryRun: r.dryRun, dependentes: r.dependentes };
  } catch (e) {
    db.prepare(
      "UPDATE vendas SET status_liberacao='erro', liberacao_erro=?, updated_at=datetime('now') WHERE id=?"
    ).run(e.message, vendaId);
    logEvento("liberacao_erro", vendaId, { origem, erro: e.message });
    await notificarN8N(qVenda.get(vendaId), "erro_liberacao", { erro: e.message });
    throw e;
  }
}

// disparo manual (botão "Liberar" / retentativa)
app.post("/api/vendas/:id/liberar", async (req, res) => {
  try {
    const r = await executarLiberacao(Number(req.params.id), "manual");
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ---- Bloqueio no portal (inadimplência / cancelamento) ----
async function executarBloqueio(vendaId, { motivo, origem, loginUser } = {}) {
  const venda = qVenda.get(vendaId);
  if (!venda) throw new Error("Venda não encontrada.");
  if (venda.bloqueado) return { jaBloqueado: true };

  // A inclusão é protocolar: a matrícula pode não existir no ato da liberação.
  // Resolve pela consulta de contrato (CPF do titular) no momento do bloqueio.
  let matric = venda.protheus_matric;
  if (!matric) matric = await obterMatricula(venda.titular_cpf);
  if (!matric) {
    throw new Error("Beneficiário ainda não está ativo na Medicar (matrícula não encontrada). Tente após a aprovação do cadastro.");
  }

  const blockDate = new Date().toISOString().slice(0, 10);
  try {
    const r = await bloquearBeneficiario({
      subscriberId: matric,
      reason: motivo || "000002",
      blockDate,
      loginUser: loginUser || venda.titular_nome,
    });
    db.prepare(
      `UPDATE vendas SET bloqueado=1, bloqueio_data=?, bloqueio_motivo=?, protheus_matric=?, bloqueio_erro=NULL,
       status_liberacao='bloqueado', updated_at=datetime('now') WHERE id=?`
    ).run(blockDate, motivo || "000002", matric, vendaId);
    logEvento("bloqueio", vendaId, { origem, motivo, ...r });
    return { ok: true, dryRun: r.dryRun, blockDate };
  } catch (e) {
    db.prepare("UPDATE vendas SET bloqueio_erro=?, updated_at=datetime('now') WHERE id=?").run(e.message, vendaId);
    logEvento("bloqueio_erro", vendaId, { origem, erro: e.message });
    throw e;
  }
}

// bloquear beneficiário no portal
app.post("/api/vendas/:id/bloquear", async (req, res) => {
  try {
    const r = await executarBloqueio(Number(req.params.id), {
      motivo: req.body?.motivo,
      origem: "manual",
      loginUser: req.usuario?.nome,
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ---- Desbloqueio no portal (pagamento regularizado) ----
async function executarDesbloqueio(vendaId, { origem, loginUser } = {}) {
  const venda = qVenda.get(vendaId);
  if (!venda) throw new Error("Venda não encontrada.");
  if (!venda.bloqueado) return { naoEstavaBloqueado: true };

  let matric = venda.protheus_matric;
  if (!matric) matric = await obterMatricula(venda.titular_cpf);
  if (!matric) throw new Error("Beneficiário sem matrícula para desbloquear.");

  const data = new Date().toISOString().slice(0, 10);
  try {
    // desbloqueio usa a data do bloqueio (o cliente protheus calcula "data − 1 dia" e reason 000004)
    const r = await desbloquearBeneficiario({
      subscriberId: matric,
      blockDate: venda.bloqueio_data,
      loginUser: loginUser || venda.titular_nome,
    });
    db.prepare(
      `UPDATE vendas SET bloqueado=0, desbloqueio_em=?, protheus_matric=?, bloqueio_erro=NULL,
       status_liberacao='liberado', updated_at=datetime('now') WHERE id=?`
    ).run(data, matric, vendaId);
    logEvento("desbloqueio", vendaId, { origem, ...r });
    await notificarN8N(qVenda.get(vendaId), "desbloqueado", { origem });
    return { ok: true, dryRun: r.dryRun };
  } catch (e) {
    db.prepare("UPDATE vendas SET bloqueio_erro=?, updated_at=datetime('now') WHERE id=?").run(e.message, vendaId);
    logEvento("desbloqueio_erro", vendaId, { origem, erro: e.message });
    throw e;
  }
}

// desbloquear beneficiário no portal (manual)
app.post("/api/vendas/:id/desbloquear", async (req, res) => {
  try {
    const r = await executarDesbloqueio(Number(req.params.id), { origem: "manual", loginUser: req.usuario?.nome });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// cancelar a assinatura no Asaas (opcionalmente bloqueando no portal)
app.post("/api/vendas/:id/cancelar", async (req, res) => {
  try {
    const vendaId = Number(req.params.id);
    const venda = qVenda.get(vendaId);
    if (!venda) return res.status(404).json({ erro: "Venda não encontrada." });

    if (venda.asaas_subscription_id) {
      try {
        await asaas.cancelSubscription(venda.asaas_subscription_id);
      } catch (e) {
        logEvento("cancelar_assinatura_erro", vendaId, { erro: e.message });
      }
    }
    db.prepare(
      "UPDATE vendas SET assinatura_status='cancelada', assinatura_cancelada_em=date('now'), updated_at=datetime('now') WHERE id=?"
    ).run(vendaId);
    logEvento("assinatura_cancelada", vendaId, { origem: "manual" });

    let bloqueio = null;
    if (req.body?.bloquear) {
      try {
        bloqueio = await executarBloqueio(vendaId, { motivo: req.body?.motivo || "000002", origem: "cancelamento" });
      } catch (e) {
        bloqueio = { erro: e.message };
      }
    }
    res.json({ ok: true, bloqueio });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =====================================================================
//  Processamento de pagamento (compartilhado por webhook e sincronização)
// =====================================================================
function resolverVendaId(payment) {
  let vendaId = null;
  if (payment.subscription) {
    vendaId = db.prepare("SELECT id FROM vendas WHERE asaas_subscription_id=?").get(payment.subscription)?.id ?? null;
  }
  if (!vendaId && payment.externalReference?.startsWith("venda:")) {
    vendaId = Number(payment.externalReference.split(":")[1]) || null;
  }
  return vendaId;
}

async function processarPagamento(payment, origem) {
  const vendaId = resolverVendaId(payment);
  upsertCobranca(payment, vendaId);
  if (!vendaId) return { vendaId: null, acao: null };

  const statusAntes = qVenda.get(vendaId)?.status_pagamento;
  db.prepare("UPDATE vendas SET status_pagamento=?, updated_at=datetime('now') WHERE id=?")
    .run(mapPagamento(payment.status), vendaId);

  let acao = null;
  if (PAGO.has(payment.status)) {
    const venda = qVenda.get(vendaId);
    // avisa o N8N do pagamento confirmado só na transição para pago (evita repetir a cada sync)
    if (venda && !["confirmado", "recebido"].includes(statusAntes)) {
      await notificarN8N(venda, "pagamento_confirmado", { origem });
    }
    if (venda && venda.bloqueado) {
      // estava bloqueado por inadimplência e regularizou -> desbloqueia
      try { await executarDesbloqueio(vendaId, origem); acao = "desbloqueado"; }
      catch (e) { console.error(`Desbloqueio (${origem}) venda ${vendaId}:`, e.message); }
    } else if (venda && venda.status_liberacao !== "liberado") {
      // primeira confirmação -> libera no portal (idempotente)
      try { await executarLiberacao(vendaId, origem); acao = "liberado"; }
      catch (e) { console.error(`Liberação (${origem}) venda ${vendaId}:`, e.message); }
    }
  } else if (payment.status === "OVERDUE" && AUTO_BLOQUEAR_VENCIDO) {
    // inadimplência -> bloqueia no portal (a matrícula é resolvida dentro de executarBloqueio)
    const venda = qVenda.get(vendaId);
    if (venda && !venda.bloqueado) {
      try { await executarBloqueio(vendaId, { motivo: "000002", origem }); acao = "bloqueado"; }
      catch (e) { console.error(`Bloqueio (${origem}) venda ${vendaId}:`, e.message); }
    }
  }
  return { vendaId, acao };
}

// =====================================================================
//  Webhook Asaas (tempo real — usado quando há URL pública)
// =====================================================================
app.post("/webhooks/asaas", async (req, res) => {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (expected && req.get("asaas-access-token") !== expected) {
    return res.status(401).json({ erro: "token inválido" });
  }
  const evt = req.body || {};
  const payment = evt.payment;
  logEvento("webhook", evt.event, { id: evt.id, paymentId: payment?.id, status: payment?.status });
  res.json({ received: true }); // responde rápido para o Asaas não reenfileirar
  if (!payment) return;
  try { await processarPagamento(payment, `webhook:${evt.event}`); }
  catch (e) { console.error("Erro processando webhook:", e.message); logEvento("webhook_erro", evt?.event, { erro: e.message }); }
});

// =====================================================================
//  Sincronização com o Asaas (polling — funciona sem URL pública)
// =====================================================================
async function sincronizarAsaas(origem = "auto") {
  if (!asaas.configured) throw new Error("Asaas não configurado (defina ASAAS_API_KEY).");
  const vendas = db.prepare(
    "SELECT id, asaas_subscription_id FROM vendas WHERE asaas_subscription_id IS NOT NULL AND assinatura_status='ativa'"
  ).all();

  let cobrancasVistas = 0;
  const acoes = [];
  for (const v of vendas) {
    try {
      const pays = await asaas.getSubscriptionPayments(v.asaas_subscription_id);
      for (const p of pays?.data || []) {
        cobrancasVistas++;
        const r = await processarPagamento(p, `sync:${origem}`);
        if (r.acao) acoes.push({ venda: v.id, acao: r.acao });
      }
    } catch (e) {
      logEvento("sync_erro", v.id, { erro: e.message });
    }
  }
  ultimaSync = new Date().toISOString();
  logEvento("sync", null, { origem, assinaturas: vendas.length, cobrancasVistas, acoes });
  return { assinaturas: vendas.length, cobrancasVistas, acoes, ultimaSync };
}

// sincronização manual (botão "Sincronizar com o Asaas")
app.post("/api/asaas/sincronizar", async (req, res) => {
  try { const r = await sincronizarAsaas("manual"); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get("/api/asaas/status", (req, res) =>
  res.json({ configurado: asaas.configured, baseUrl: asaas.baseUrl, ultimaSync, intervaloMin: SYNC_MIN }));

// =====================================================================
//  Relatórios e exportação
// =====================================================================

// Evolução da carteira: vidas e MRR acumulados por mês
app.get("/api/relatorios/carteira", (req, res) => {
  const rows = db
    .prepare(
      `SELECT substr(created_at,1,7) AS mes,
              COUNT(*) AS vendas,
              SUM(valor) AS receita,
              SUM(1 + (SELECT COUNT(*) FROM dependentes d WHERE d.venda_id=v.id)) AS vidas
       FROM vendas v
       GROUP BY mes ORDER BY mes`
    )
    .all();
  let vidasAcc = 0, mrrAcc = 0;
  const serie = rows.map((r) => {
    vidasAcc += r.vidas;
    mrrAcc += r.receita;
    return { mes: r.mes, vendas: r.vendas, vidas: r.vidas, vidasAcumuladas: vidasAcc, mrr: Number(mrrAcc.toFixed(2)) };
  });
  res.json(serie);
});

// Inadimplência: vendas com cobranças vencidas (valor em risco e dias em atraso)
app.get("/api/relatorios/inadimplencia", (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.id AS venda_id, v.titular_nome, v.titular_cpf, v.tipo_plano, v.bloqueado,
              COUNT(c.id) AS qtd_vencidas,
              COALESCE(SUM(c.value),0) AS valor_em_risco,
              MIN(c.due_date) AS vencimento_mais_antigo
       FROM cobrancas c
       JOIN vendas v ON v.id = c.venda_id
       WHERE c.status = 'OVERDUE'
       GROUP BY v.id
       ORDER BY vencimento_mais_antigo ASC`
    )
    .all();
  const hoje = new Date();
  const lista = rows.map((r) => {
    const dias = r.vencimento_mais_antigo
      ? Math.max(0, Math.floor((hoje - new Date(r.vencimento_mais_antigo)) / 86400000))
      : 0;
    return { ...r, dias_atraso: dias };
  });
  const total = lista.reduce((s, r) => s + r.valor_em_risco, 0);
  res.json({ total_em_risco: Number(total.toFixed(2)), clientes: lista.length, lista });
});

// Churn: cancelamentos no período, taxa e motivos
app.get("/api/relatorios/churn", (req, res) => {
  const hoje = new Date().toISOString().slice(0, 10);
  const de = (req.query.de || `${hoje.slice(0, 7)}-01`).slice(0, 10);
  const ate = (req.query.ate || hoje).slice(0, 10);

  const canceladas = db
    .prepare("SELECT COUNT(*) n FROM vendas WHERE assinatura_cancelada_em BETWEEN ? AND ?")
    .get(de, ate).n;
  const ativasNoInicio = db
    .prepare("SELECT COUNT(*) n FROM vendas WHERE date(created_at) < ? AND asaas_subscription_id IS NOT NULL")
    .get(de).n;
  const taxa = ativasNoInicio ? Number(((canceladas / ativasNoInicio) * 100).toFixed(1)) : 0;

  const porMotivo = db
    .prepare(
      `SELECT COALESCE(bloqueio_motivo,'—') motivo, COUNT(*) n
       FROM vendas WHERE assinatura_cancelada_em BETWEEN ? AND ? GROUP BY motivo ORDER BY n DESC`
    )
    .all(de, ate);
  const lista = db
    .prepare(
      `SELECT id, titular_nome, tipo_plano, valor, assinatura_cancelada_em, bloqueio_motivo
       FROM vendas WHERE assinatura_cancelada_em BETWEEN ? AND ? ORDER BY assinatura_cancelada_em DESC`
    )
    .all(de, ate);

  res.json({ periodo: { de, ate }, canceladas, taxaChurn: taxa, porMotivo, lista });
});

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, headers, rows) {
  const linhas = [headers.join(";"), ...rows.map((r) => r.map(csvEscape).join(";"))];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + linhas.join("\r\n")); // BOM p/ Excel abrir acentos
}

app.get("/api/export/vendas.csv", (req, res) => {
  const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM dependentes d WHERE d.venda_id=v.id) qd FROM vendas v ORDER BY v.id`).all();
  sendCsv(
    res, "vendas.csv",
    ["ID","Titular","CPF","Plano","Valor","Dependentes","Pagamento","Liberacao","Bloqueado","Matricula","Assinatura","Vendedor","Criada em"],
    rows.map((v) => [v.id, v.titular_nome, v.titular_cpf, v.tipo_plano, v.valor, v.qd, v.status_pagamento, v.status_liberacao, v.bloqueado ? "Sim" : "Nao", v.protheus_matric, v.assinatura_status, v.vendedor, v.created_at])
  );
});

app.get("/api/export/cobrancas.csv", (req, res) => {
  const rows = db.prepare(`SELECT c.*, v.titular_nome FROM cobrancas c LEFT JOIN vendas v ON v.id=c.venda_id ORDER BY c.due_date`).all();
  sendCsv(
    res, "cobrancas.csv",
    ["ID Asaas","Titular","Forma","Valor","Status","Vencimento","Pagamento"],
    rows.map((c) => [c.asaas_payment_id, c.titular_nome, c.billing_type, c.value, c.status, c.due_date, c.payment_date])
  );
});

// health
app.get("/api/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  const p = protheusConfig();
  console.log(`\n  Banneg Telemedicina rodando em  http://localhost:${PORT}`);
  console.log(`  Asaas:    ${asaas.configured ? asaas.baseUrl : "⚠  ASAAS_API_KEY não configurada"}`);
  console.log(`  Protheus: ${p.baseUrl || "não configurado"}  ${p.dryRun ? "(MODO SIMULAÇÃO)" : "(LIBERAÇÃO REAL)"}`);
  console.log(`  Webhook:  POST http://localhost:${PORT}/webhooks/asaas`);

  // Sincronização automática com o Asaas (polling)
  if (asaas.configured && SYNC_MIN > 0) {
    console.log(`  Sync:     a cada ${SYNC_MIN} min (polling do Asaas)\n`);
    setTimeout(() => sincronizarAsaas("inicial").catch((e) => console.error("Sync inicial:", e.message)), 8000);
    setInterval(() => sincronizarAsaas("auto").catch((e) => console.error("Sync:", e.message)), SYNC_MIN * 60_000);
  } else {
    console.log("");
  }
});
