# Banneg Telemedicina — Sistema de Vendas e Liberação

Sistema simples para **vender telemedicina (Medicar)**, cobrar via **Asaas** e **liberar o beneficiário no portal** (TOTVS Protheus PLS) automaticamente quando o pagamento é confirmado.

## Fluxo

```
Vendedor cadastra a venda
        │
        ▼
Cria cliente + assinatura mensal no Asaas  ──►  gera link de pagamento (Pix ou Cartão)
        │
        ▼
Cliente paga  ──►  Asaas dispara webhook  ──►  sistema libera o beneficiário no Protheus
        │                                            (titular grau 00 + dependentes)
        ▼
Dashboard mostra vendas, MRR, cobranças e liberações
```

## Requisitos

- Node.js 22+ (usa o SQLite embutido `node:sqlite`, sem compilação nativa)

## Como rodar

```bash
cd sistema
npm install
npm start
```

Abra **http://localhost:3000**.

No Windows, você também pode dar dois cliques em **`Abrir Banneg.bat`** (sobe o servidor e abre o navegador).

## Login

Na primeira execução é criado um usuário administrador (definido em `.env`):

- Usuário: `admin`  ·  Senha: `banneg123`  *(troque em produção via `ADMIN_USER`/`ADMIN_PASSWORD`)*

Cada venda registra automaticamente o vendedor logado. Todas as telas exigem login.

## Funcionalidades

- **Vendas**: cria cliente + assinatura mensal no Asaas e gera o link de pagamento.
- **Liberação automática**: ao confirmar o pagamento (webhook), inclui o beneficiário no portal.
- **Bloqueio/cancelamento**: bloqueia o beneficiário no portal (motivos: desligamento, financeiro, cadastro indevido) e cancela a assinatura no Asaas. Pode ser automático na inadimplência (`AUTO_BLOQUEAR_VENCIDO=true`) ou manual pelo botão **Bloquear**.
- **Desbloqueio**: quando o pagamento é regularizado (webhook de pagamento confirmado), o beneficiário bloqueado é **desbloqueado automaticamente** no portal. Também há o botão **Desbloquear** manual. ⚠️ O endpoint de desbloqueio (`PROTHEUS_UNBLOCK_PATH`) **não constava na documentação recebida** — confirme o path/payload exato com a Medicar/TOTVS antes de sair do modo simulação.
- **Dashboard**: KPIs, gráfico de evolução da carteira (vidas + MRR), busca e filtros, e exportação CSV de vendas e cobranças.
- **Relatórios de gestão**:
  - **Filtro por período** (data inicial/final) com resumo: vendas, recebido, ticket médio e cancelamentos no período.
  - **Inadimplência detalhada**: clientes com cobrança vencida, dias em atraso e valor em risco — com ação de bloqueio.
  - **Churn**: cancelamentos no período, taxa de churn e motivos.

## Dados de demonstração

Para ver o painel populado (dados fictícios) e depois limpar:

```bash
npm run demo     # insere 10 vendas de exemplo (ou dois cliques em "Carregar dados demo.bat")
npm run reset    # apaga todas as vendas/cobranças, mantém o login ("Limpar dados.bat")
```

## Configuração (`.env`)

O arquivo `.env` já vem preenchido com a **homologação da Medicar** e o **modo simulação ligado**. Você só precisa completar 2 coisas:

1. **Chave do Asaas** — crie uma conta Sandbox em https://sandbox.asaas.com, gere a API Key em *Integrações → API* e cole em:
   ```
   ASAAS_API_KEY=sua_chave_aqui
   ```
2. Quando quiser **liberar de verdade** no portal (sair da simulação):
   ```
   PROTHEUS_DRY_RUN=false
   ```

Reinicie o servidor após editar o `.env`.

### Variáveis principais

| Variável | Descrição |
|---|---|
| `ASAAS_BASE_URL` | Sandbox (padrão) ou produção (`https://api.asaas.com/v3`) |
| `ASAAS_API_KEY` | Chave de API do Asaas |
| `ASAAS_WEBHOOK_TOKEN` | (Opcional) valida o webhook; use o mesmo valor no painel do Asaas |
| `PROTHEUS_*` | Credenciais e dados do contrato Medicar |
| `PROTHEUS_DRY_RUN` | `true` = não envia ao portal (só registra) · `false` = libera de verdade |
| `AUTO_BLOQUEAR_VENCIDO` | `true` = bloqueia automaticamente no portal quando a cobrança vence |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Usuário admin criado na primeira execução |

## Como o sistema detecta o pagamento

Há dois mecanismos (podem coexistir):

1. **Sincronização automática (polling)** — recomendada rodando local. O sistema consulta o Asaas a cada `ASAAS_SYNC_MINUTES` (padrão 5) e libera/desbloqueia quem pagou. **Não precisa de URL pública.** Há também o botão **"Sincronizar agora"** na Visão geral. Coloque `ASAAS_SYNC_MINUTES=0` para desligar.
2. **Webhook (tempo real)** — quando o sistema estiver hospedado com URL pública. Ver abaixo.

## Webhook do Asaas

No painel do Asaas (*Integrações → Webhooks*), aponte para:

```
POST  http://SEU_SERVIDOR:3000/webhooks/asaas
```

Eventos que interessam: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_CREATED`.

> Em desenvolvimento local, exponha a porta com um túnel (ex.: `ngrok http 3000`) para o Asaas alcançar seu `/webhooks/asaas`. Enquanto isso, você pode liberar manualmente pelo botão **Liberar** no dashboard.

## Integração com o N8N (vendas automáticas)

O agente de IA do N8N cria a venda chamando a API e recebe o link/Pix para mandar ao lead. Depois, o sistema **avisa o N8N** (callback) a cada mudança.

**Autenticação:** header `Authorization: Bearer <INTEGRACAO_API_KEY>` (ou `x-api-key`). Configure a chave no `.env`/EasyPanel.

**Criar venda** — `POST /api/vendas`

Pessoa física:
```json
{
  "externalId": "id-da-conversa-no-n8n",
  "tipo_plano": "individual",
  "billingType": "PIX",
  "titular": { "nome": "Nome Sobrenome", "cpf": "00000000000", "nascimento": "1990-01-20",
               "sexo": "1", "estciv": "S", "mae": "Nome da Mãe", "email": "x@y.com", "ddd": "11", "telefone": "999990000" },
  "dependentes": []
}
```
Empresa: `{ "externalId", "tipo_plano":"empresa", "billingType", "empresa":{ "razao_social","cnpj","email","ddd","telefone" }, "vidas":[ ... ] }`

Resposta: `{ ok, venda_id, externalId, paymentLink, pixCopiaECola, valor, ... }`. O `externalId` garante **idempotência** (reenviar não duplica a venda).

**Consultar status:** `GET /api/vendas/:id` (mesma chave).

**Callbacks (o sistema → N8N):** configure `N8N_WEBHOOK_URL` com a URL do seu webhook no N8N. Eventos enviados (POST JSON): `pagamento_confirmado`, `cadastro_enviado` (protocolo de inclusão enviado à Medicar; a ativação ocorre após a aprovação deles), `erro_liberacao`, `desbloqueado`. O payload inclui `acesso` (login = CPF; senha inicial = CPF).

## Deploy no EasyPanel (VPS Hostinger)

1. Suba a pasta `sistema/` como um app no EasyPanel (build pelo `Dockerfile`).
2. **Monte um volume** em `/app/data` (persistência do banco SQLite).
3. Configure as **variáveis** no painel (não usa `.env`): `ASAAS_*`, `PROTHEUS_*` (com `PROTHEUS_DRY_RUN=false`), `ADMIN_PASSWORD` forte, `INTEGRACAO_API_KEY` forte, `N8N_WEBHOOK_URL`, `ASAAS_WEBHOOK_TOKEN`.
4. Use o **domínio HTTPS** do EasyPanel como `BANNEG_URL` no N8N, e aponte o webhook do Asaas para `https://<dominio>/webhooks/asaas`.
5. **Medicar:** a produção só aceita **IPs do Brasil** — garanta que o VPS esteja em **região BR (São Paulo)**. Não há liberação de IP a solicitar.

## Estrutura

```
sistema/
├── src/
│   ├── server.js    API + webhook + orquestração
│   ├── asaas.js     cliente da API Asaas
│   ├── protheus.js  cliente do portal (token, contrato, inclusão de beneficiários)
│   ├── planos.js    planos e tabelas de domínio (parentesco, sexo, estado civil)
│   └── db.js        banco SQLite (vendas, dependentes, cobranças, eventos)
├── public/          dashboard e formulário de nova venda
└── data/            banco de dados (gerado automaticamente)
```

## Planos (pessoa física)

Formas de pagamento aceitas: **Pix** e **cartão de crédito** (o valor muda conforme a forma).

| Plano | Cartão | Pix | Vidas |
|---|---|---|---|
| Individual | R$ 26,00 | R$ 32,00 | 1 |
| Familiar | R$ 59,90 | R$ 69,90 | titular + até 3 (4 vidas) |

Familiar acima de 4 vidas: **+ R$ 15,00 por pessoa adicional** (na mesma forma de pagamento). O valor é sempre calculado no servidor a partir do plano, forma de pagamento e nº de vidas.

## Planos (empresa / PME)

Apenas CNPJ. Preço **único por vida** (igual no cartão ou Pix), multiplicado pelo total de vidas. A faixa é definida pelo total:

| Total de vidas | Preço por vida |
|---|---|
| 1 a 10 | R$ 24,00 |
| 11 a 50 | R$ 22,50 |
| 51 a 100 | R$ 19,90 |
| acima de 100 | **cotação com consultor** (registrada sem cobrança) |

No cadastro da empresa dá para adicionar as vidas manualmente ou **importar em massa** (uma por linha: `Nome;CPF;AAAA-MM-DD;M/F`).

> ⚠️ A **liberação de PME no portal** (inclusão de pessoa jurídica no Protheus) segue o mesmo padrão do contrato familiar, mas os campos específicos de PJ **precisam ser confirmados com a Medicar** antes de sair do modo simulação (`PROTHEUS_DRY_RUN=false`).

## Observações importantes

- **Códigos do Protheus** (grau de parentesco, sexo, estado civil, motivos de bloqueio) foram extraídos da *API de Beneficiarios v1.5*. O titular é sempre incluído com grau `00` e os mesmos dados do master (BBA).
- A **matrícula (BBA_MATRIC)** do titular é recuperada consultando o contrato pelo CPF após a inclusão, e usada para vincular os dependentes à família.
- A liberação é **idempotente**: se o titular já existir, o sistema reaproveita a matrícula e não duplica.
- Antes de ir para **produção**: troque a chave do Asaas pela de produção, `ASAAS_BASE_URL` para `https://api.asaas.com/v3`, e valide o fluxo de inclusão no ambiente de produção do Protheus com a Medicar.
