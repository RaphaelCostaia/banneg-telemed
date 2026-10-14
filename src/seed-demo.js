// Popula o banco com dados FICTÍCIOS para demonstração dos relatórios.
// Rodar:  npm run demo      |  Limpar depois:  npm run reset
import { db } from "./db.js";

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthsAgo = (n) => { const d = new Date(now); d.setMonth(d.getMonth() - n); return d; };
const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };

let matricSeq = 1;
const novaMatric = () => "0001100800" + String(1000 + matricSeq++).padStart(7, "0");

const insVenda = db.prepare(`INSERT INTO vendas
  (tipo_plano,valor,billing_type,titular_nome,titular_cpf,titular_nascimento,titular_sexo,titular_estciv,titular_mae,
   asaas_customer_id,asaas_subscription_id,status_pagamento,status_liberacao,protheus_matric,liberacao_erro,
   assinatura_status,assinatura_cancelada_em,bloqueado,bloqueio_data,bloqueio_motivo,vendedor,created_at,updated_at)
  VALUES (@tipo,@valor,'PIX',@nome,@cpf,'19900101',@sexo,'S',@mae,
   @cust,@sub,@pag,@lib,@matric,@liberr,@astatus,@cancel,@bloq,@bloqd,@bloqm,@vend,@criada,@criada)`);
const insDep = db.prepare(`INSERT INTO dependentes (venda_id,nome,nascimento,sexo,grau_parentesco,mae,liberado) VALUES (?,?,?,?,?,?,?)`);
const insCob = db.prepare(`INSERT INTO cobrancas (venda_id,asaas_payment_id,value,status,billing_type,due_date,payment_date,invoice_url) VALUES (?,?,?,?,?,?,?,?)`);

let cobSeq = 1;
function cobranca(vendaId, value, status, dueDate, paymentDate) {
  insCob.run(vendaId, "pay_demo_" + cobSeq++, value, status, "PIX", dueDate, paymentDate || null,
    "https://sandbox.asaas.com/i/demo");
}

function criar(v) {
  const info = insVenda.run({
    tipo: v.tipo, valor: v.valor, nome: v.nome, cpf: v.cpf, sexo: v.sexo || "1", mae: v.mae || "MARIA",
    cust: "cus_demo" + (matricSeq), sub: v.sub === false ? null : "sub_demo" + matricSeq,
    pag: v.pag, lib: v.lib, matric: v.matric || null, liberr: v.liberr || null,
    astatus: v.astatus || "ativa", cancel: v.cancel || null,
    bloq: v.bloq ? 1 : 0, bloqd: v.bloqd || null, bloqm: v.bloqm || null,
    vend: v.vend, criada: v.criada,
  });
  const id = Number(info.lastInsertRowid);
  (v.deps || []).forEach((d) => insDep.run(id, d, "20120101", "1", "05", v.mae || "MARIA", v.lib === "liberado" ? 1 : 0));
  (v.cobrancas || []).forEach((c) => cobranca(id, v.valor, c.status, c.due, c.pay));
  return id;
}

const V = "Rafael", D = "Débora";

// 1) Cliente saudável, familiar, 3 meses pagando (carteira antiga)
criar({ tipo: "familiar", valor: 49.9, nome: "ANA PAULA FERREIRA", cpf: "11111111111", vend: V,
  pag: "recebido", lib: "liberado", matric: novaMatric(), deps: ["LUCAS FERREIRA", "MARINA FERREIRA", "PEDRO FERREIRA"],
  criada: iso(monthsAgo(2)) + " 10:00",
  cobrancas: [
    { status: "RECEIVED", due: iso(monthsAgo(2)), pay: iso(monthsAgo(2)) },
    { status: "RECEIVED", due: iso(monthsAgo(1)), pay: iso(monthsAgo(1)) },
    { status: "RECEIVED", due: iso(new Date(now.getFullYear(), now.getMonth(), 3)), pay: iso(daysAgo(2)) },
  ] });

// 2) Individual, ficou inadimplente este mês (pagou 2, venceu 1)
criar({ tipo: "unitario", valor: 21.9, nome: "BRUNO COSTA", cpf: "22222222222", vend: D,
  pag: "vencido", lib: "liberado", matric: novaMatric(),
  criada: iso(monthsAgo(2)) + " 14:20",
  cobrancas: [
    { status: "RECEIVED", due: iso(monthsAgo(2)), pay: iso(monthsAgo(2)) },
    { status: "RECEIVED", due: iso(monthsAgo(1)), pay: iso(monthsAgo(1)) },
    { status: "OVERDUE", due: iso(daysAgo(12)) },
  ] });

// 3) Casal, saudável
criar({ tipo: "casal", valor: 31.9, nome: "CARLA DIAS", cpf: "33333333333", vend: V,
  pag: "recebido", lib: "liberado", matric: novaMatric(), deps: ["RENATO DIAS"],
  criada: iso(monthsAgo(1)) + " 09:15",
  cobrancas: [
    { status: "RECEIVED", due: iso(monthsAgo(1)), pay: iso(monthsAgo(1)) },
    { status: "RECEIVED", due: iso(daysAgo(4)), pay: iso(daysAgo(4)) },
  ] });

// 4) Cancelado este mês (churn - financeiro)
criar({ tipo: "unitario", valor: 21.9, nome: "DIEGO ALVES", cpf: "44444444444", vend: D,
  pag: "recebido", lib: "bloqueado", matric: novaMatric(),
  astatus: "cancelada", cancel: iso(daysAgo(5)), bloq: true, bloqd: iso(daysAgo(5)), bloqm: "000002",
  criada: iso(monthsAgo(1)) + " 16:40",
  cobrancas: [{ status: "RECEIVED", due: iso(monthsAgo(1)), pay: iso(monthsAgo(1)) }] });

// 5) Venda nova aguardando pagamento
criar({ tipo: "familiar", valor: 49.9, nome: "EDUARDA LIMA", cpf: "55555555555", vend: V,
  pag: "aguardando", lib: "pendente", deps: ["THIAGO LIMA", "SOFIA LIMA"],
  criada: iso(daysAgo(1)) + " 11:05",
  cobrancas: [{ status: "PENDING", due: iso(daysAgo(1)) }] });

// 6) Casal novo, pago e liberado
criar({ tipo: "casal", valor: 31.9, nome: "FELIPE NUNES", cpf: "66666666666", vend: D,
  pag: "recebido", lib: "liberado", matric: novaMatric(), deps: ["JULIA NUNES"],
  criada: iso(daysAgo(3)) + " 13:30",
  cobrancas: [{ status: "RECEIVED", due: iso(daysAgo(3)), pay: iso(daysAgo(3)) }] });

// 7) Individual novo, pago
criar({ tipo: "unitario", valor: 21.9, nome: "GABRIELA ROCHA", cpf: "77777777777", vend: V,
  pag: "recebido", lib: "liberado", matric: novaMatric(),
  criada: iso(daysAgo(2)) + " 08:50",
  cobrancas: [{ status: "RECEIVED", due: iso(daysAgo(2)), pay: iso(daysAgo(2)) }] });

// 8) Inadimplente antigo (40 dias em atraso), ainda não bloqueado
criar({ tipo: "unitario", valor: 21.9, nome: "HEITOR SOUZA", cpf: "88888888888", vend: D,
  pag: "vencido", lib: "liberado", matric: novaMatric(),
  criada: iso(monthsAgo(2)) + " 15:10",
  cobrancas: [
    { status: "RECEIVED", due: iso(monthsAgo(2)), pay: iso(monthsAgo(2)) },
    { status: "OVERDUE", due: iso(daysAgo(40)) },
  ] });

// 9) Cancelado no mês passado (churn - desligamento)
criar({ tipo: "casal", valor: 31.9, nome: "ISABELA MARTINS", cpf: "99999999999", vend: V,
  pag: "recebido", lib: "bloqueado", matric: novaMatric(), deps: ["MARCOS MARTINS"],
  astatus: "cancelada", cancel: iso(monthsAgo(1)), bloq: true, bloqd: iso(monthsAgo(1)), bloqm: "000001",
  criada: iso(monthsAgo(2)) + " 10:25",
  cobrancas: [{ status: "RECEIVED", due: iso(monthsAgo(2)), pay: iso(monthsAgo(2)) }] });

// 10) Erro de liberação (pagou mas falhou no portal)
criar({ tipo: "familiar", valor: 49.9, nome: "JOAO PEDRO ANDRADE", cpf: "10101010101", vend: D,
  pag: "recebido", lib: "erro", liberr: "Titular incluído, mas não foi possível recuperar a matrícula.",
  deps: ["LARA ANDRADE"], criada: iso(daysAgo(1)) + " 17:00",
  cobrancas: [{ status: "RECEIVED", due: iso(daysAgo(1)), pay: iso(daysAgo(1)) }] });

const total = db.prepare("SELECT COUNT(*) n FROM vendas").get().n;
console.log(`✅ Dados de demonstração inseridos. Total de vendas no banco: ${total}`);
console.log('   Para limpar tudo:  npm run reset');
