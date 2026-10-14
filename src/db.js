import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "banneg.db"));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_plano TEXT NOT NULL,
  valor REAL NOT NULL,
  ciclo TEXT NOT NULL DEFAULT 'MONTHLY',
  billing_type TEXT NOT NULL DEFAULT 'PIX',

  titular_nome TEXT NOT NULL,
  titular_cpf TEXT NOT NULL,
  titular_nascimento TEXT,        -- YYYYMMDD
  titular_sexo TEXT,              -- 1 | 2
  titular_estciv TEXT,
  titular_mae TEXT,
  titular_email TEXT,
  titular_ddd TEXT,
  titular_telefone TEXT,

  asaas_customer_id TEXT,
  asaas_subscription_id TEXT,

  status_pagamento TEXT NOT NULL DEFAULT 'aguardando', -- aguardando|confirmado|recebido|vencido|estornado
  status_liberacao TEXT NOT NULL DEFAULT 'pendente',   -- pendente|liberado|erro
  protheus_matric TEXT,
  liberacao_erro TEXT,
  primeira_cobranca_url TEXT,

  vendedor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dependentes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cpf TEXT,
  nascimento TEXT,               -- YYYYMMDD
  sexo TEXT,
  estciv TEXT,
  grau_parentesco TEXT NOT NULL, -- código B2N_GRAUPA
  mae TEXT,
  liberado INTEGER NOT NULL DEFAULT 0,
  protheus_erro TEXT
);

CREATE TABLE IF NOT EXISTS cobrancas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  asaas_payment_id TEXT UNIQUE,
  value REAL,
  status TEXT,
  billing_type TEXT,
  due_date TEXT,
  payment_date TEXT,
  invoice_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  referencia TEXT,
  detalhe TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'vendedor', -- admin | vendedor
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cobrancas_venda ON cobrancas(venda_id);
CREATE INDEX IF NOT EXISTS idx_dependentes_venda ON dependentes(venda_id);
`);

// ---- migração segura: adiciona colunas novas se ainda não existirem ----
function ensureColumn(tabela, coluna, definicao) {
  const cols = db.prepare(`PRAGMA table_info(${tabela})`).all();
  if (!cols.some((c) => c.name === coluna)) {
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
}
ensureColumn("vendas", "assinatura_status", "TEXT DEFAULT 'ativa'"); // ativa | cancelada
ensureColumn("vendas", "assinatura_cancelada_em", "TEXT");
ensureColumn("vendas", "bloqueado", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("vendas", "bloqueio_data", "TEXT");
ensureColumn("vendas", "bloqueio_motivo", "TEXT");
ensureColumn("vendas", "bloqueio_erro", "TEXT");
ensureColumn("vendas", "desbloqueio_em", "TEXT");
// Empresa (PME)
ensureColumn("vendas", "tipo_pessoa", "TEXT NOT NULL DEFAULT 'fisica'"); // fisica | juridica
ensureColumn("vendas", "cnpj", "TEXT");
ensureColumn("vendas", "razao_social", "TEXT");
ensureColumn("vendas", "qtd_vidas", "INTEGER");
// Idempotência da integração (ex.: id da conversa/negócio no N8N)
ensureColumn("vendas", "external_id", "TEXT");

export function logEvento(tipo, referencia, detalhe) {
  try {
    db.prepare(
      "INSERT INTO eventos (tipo, referencia, detalhe) VALUES (?, ?, ?)"
    ).run(
      tipo,
      referencia != null ? String(referencia) : null,
      detalhe != null ? JSON.stringify(detalhe) : null
    );
  } catch (e) {
    console.error("Falha ao registrar evento:", e.message);
  }
}
