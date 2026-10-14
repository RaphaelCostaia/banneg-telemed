// Catálogo de planos da Banneg Telemedicina e tabelas de domínio do Protheus PLS.
// Os códigos abaixo foram extraídos da "API de Beneficiarios v1.5" (Medicar/TOTVS).

// Formas de pagamento aceitas (produção): apenas PIX e cartão de crédito.
export const FORMAS_PAGAMENTO = {
  CREDIT_CARD: "Cartão de crédito",
  PIX: "Pix",
};

// Planos de PESSOA FÍSICA. Preço varia por forma de pagamento.
// Familiar: preço base cobre até 4 vidas (titular + 3); cada vida adicional soma R$15,00.
export const PLANOS = {
  individual: {
    id: "individual",
    nome: "Individual",
    maxDependentes: 0, // apenas o titular (1 vida)
    vidasBase: 1,
    preco: { CREDIT_CARD: 26.0, PIX: 32.0 },
    descricao: "Telemedicina Individual - 1 vida",
  },
  familiar: {
    id: "familiar",
    nome: "Familiar",
    maxDependentes: 9, // titular + até 9 (base cobre 4 vidas; extras somam R$15/vida)
    vidasBase: 4,
    adicionalPorVida: 15.0,
    preco: { CREDIT_CARD: 59.9, PIX: 69.9 },
    descricao: "Telemedicina Familiar - titular + dependentes (base 4 vidas)",
  },
};

export function getPlano(id) {
  return PLANOS[id] || null;
}

// Planos de EMPRESA (PME) — apenas CNPJ. Preço único por vida (igual no cartão ou Pix),
// definido pela faixa do total de vidas, multiplicado pelo nº de vidas.
export const FAIXAS_PME = [
  { min: 1, max: 10, porVida: 24.0 },
  { min: 11, max: 50, porVida: 22.5 },
  { min: 51, max: 100, porVida: 19.9 },
  // acima de 100: sem preço automático -> cotação com consultor
];
export const PME_LIMITE_COTACAO = 100;

// Retorna o preço por vida da faixa, ou null se exigir cotação (>100).
export function precoPorVidaPME(qtdVidas) {
  const n = Number(qtdVidas) || 0;
  const faixa = FAIXAS_PME.find((f) => n >= f.min && n <= f.max);
  return faixa ? faixa.porVida : null;
}

// Valor mensal total da empresa (porVida × vidas). null quando exige cotação (>100 vidas).
export function calcularValorEmpresa(qtdVidas) {
  const pv = precoPorVidaPME(qtdVidas);
  if (pv == null) return null;
  return Number((pv * Number(qtdVidas)).toFixed(2));
}

// Calcula o valor mensal a partir do plano, forma de pagamento e nº total de vidas (titular + dependentes).
export function calcularValor(planoId, billingType, qtdVidas) {
  const p = PLANOS[planoId];
  if (!p) return null;
  const base = p.preco?.[billingType];
  if (base == null) return null; // forma de pagamento não permitida
  const vidas = Math.max(1, Number(qtdVidas) || 1);
  if (p.adicionalPorVida && vidas > p.vidasBase) {
    return Number((base + (vidas - p.vidasBase) * p.adicionalPorVida).toFixed(2));
  }
  return Number(base.toFixed(2));
}

// B2N_SEXO: 1 = Masculino, 2 = Feminino
export const SEXOS = {
  1: "Masculino",
  2: "Feminino",
};

// B2N_ESTCIV (SX5 tabela 33)
export const ESTADOS_CIVIS = {
  C: "Casado(a)",
  D: "Divorciado(a)",
  M: "União Estável",
  Q: "Desquitado(a)",
  S: "Solteiro(a)",
  V: "Viúvo(a)",
  O: "Outros",
};

// B2N_GRAUPA - Grau de parentesco (BRP). Titular sempre "00".
export const GRAUS_PARENTESCO = {
  "00": "Titular",
  "02": "Esposa",
  "03": "Companheiro(a)",
  "04": "Esposo",
  "05": "Filho",
  "06": "Filha",
  "07": "Pai",
  "08": "Mãe",
  "09": "Sogro",
  "10": "Sogra",
  "11": "Outro dependente",
  "12": "Filho adotivo",
  "13": "Filha adotiva",
  "14": "Irmão",
  "15": "Irmã",
  "16": "Agregado",
};

// B9G_COD - Motivos de bloqueio/cancelamento ("000004" = desbloqueio/reativação)
export const MOTIVOS_BLOQUEIO = {
  "000001": "Desligamento da empresa",
  "000002": "Financeiro",
  "000003": "Cadastro indevido",
};
export const REASON_DESBLOQUEIO = "000004";

// Validação de nome no padrão ANS (reduz rejeição do protocolo na Medicar).
// Regras: >=2 palavras; sem nome de 1 letra (exceto 1º nome D/I/O/U/Y ou último I/O/U/Y);
// sem a mesma letra repetida 3+ vezes seguidas; sem dígitos; sem caracteres especiais.
export function validarNomeANS(nome) {
  const n = String(nome || "").trim().replace(/\s+/g, " ");
  if (!n) return "Informe o nome completo.";
  if (/[0-9]/.test(n)) return "O nome não pode conter números.";
  if (/[@*{}^\\!?<>().,#~%;=+&/$\[\]"']/.test(n)) return "O nome não pode conter caracteres especiais.";
  if (/(.)\1\1/i.test(n.replace(/\s/g, ""))) return "O nome tem a mesma letra repetida muitas vezes.";
  const partes = n.split(" ").filter(Boolean);
  if (partes.length < 2) return "Informe nome e sobrenome.";
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i].replace(/[.]/g, "");
    if (p.length === 1) {
      const c = p.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
      const primeiro = i === 0 && "DIOUY".includes(c);
      const ultimo = i === partes.length - 1 && "IOUY".includes(c);
      const conectivo = "EY".includes(c);
      if (!primeiro && !ultimo && !conectivo) return `Nome inválido: "${partes[i]}" tem apenas uma letra.`;
    }
  }
  return null; // válido
}

// Mapeia os billingTypes do Asaas para rótulos amigáveis
export const BILLING_TYPES = {
  PIX: "Pix",
  BOLETO: "Boleto",
  CREDIT_CARD: "Cartão de crédito",
  UNDEFINED: "Pagador escolhe",
};
