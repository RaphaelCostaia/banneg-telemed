// Cliente da API Asaas (https://docs.asaas.com/).
// Autenticação por header `access_token`.

const BASE_URL = (process.env.ASAAS_BASE_URL || "https://api-sandbox.asaas.com/v3").replace(/\/$/, "");
const API_KEY = process.env.ASAAS_API_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json",
    access_token: API_KEY,
    "User-Agent": "BannegTelemed/1.0",
  };
}

async function request(method, path, body) {
  if (!API_KEY) {
    throw new Error(
      "ASAAS_API_KEY não configurada. Cole sua chave de API do Asaas no arquivo .env."
    );
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.errors?.map((e) => e.description).join("; ") ||
      data?.message ||
      `Erro HTTP ${res.status}`;
    const err = new Error(`Asaas: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const asaas = {
  get baseUrl() {
    return BASE_URL;
  },
  get configured() {
    return Boolean(API_KEY);
  },

  // Cria (ou reaproveita) um cliente. cpfCnpj só dígitos (CPF ou CNPJ).
  createCustomer({ name, cpfCnpj, email, mobilePhone, company, externalReference }) {
    return request("POST", "/customers", {
      name,
      cpfCnpj,
      email: email || undefined,
      mobilePhone: mobilePhone || undefined,
      company: company || undefined, // razão social (pessoa jurídica)
      externalReference: externalReference || undefined,
      notificationDisabled: false,
    });
  },

  // Assinatura recorrente. cycle padrão MONTHLY.
  createSubscription({
    customer,
    billingType,
    value,
    nextDueDate,
    cycle = "MONTHLY",
    description,
    externalReference,
  }) {
    return request("POST", "/subscriptions", {
      customer,
      billingType,
      value,
      nextDueDate,
      cycle,
      description: description || undefined,
      externalReference: externalReference || undefined,
    });
  },

  // Cobranças geradas por uma assinatura
  getSubscriptionPayments(subscriptionId) {
    return request("GET", `/subscriptions/${subscriptionId}/payments`);
  },

  getSubscription(subscriptionId) {
    return request("GET", `/subscriptions/${subscriptionId}`);
  },

  // Cancela (remove) uma assinatura recorrente
  cancelSubscription(subscriptionId) {
    return request("DELETE", `/subscriptions/${subscriptionId}`);
  },

  getPayment(paymentId) {
    return request("GET", `/payments/${paymentId}`);
  },

  // Pix copia-e-cola + QR (base64) de uma cobrança
  getPixQrCode(paymentId) {
    return request("GET", `/payments/${paymentId}/pixQrCode`);
  },

  // Link de pagamento (Pix/boleto) da cobrança
  getIdentificationField(paymentId) {
    return request("GET", `/payments/${paymentId}/identificationField`);
  },
};
