// Autenticação simples baseada em sessão (cookie httpOnly).
// Senhas com hash scrypt (node:crypto), sessões em memória. Sem dependências externas.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const sessions = new Map(); // token -> { userId, login, nome, papel, exp }

export function hashSenha(senha) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(senha), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verificarSenha(senha, armazenado) {
  if (!armazenado || !armazenado.includes(":")) return false;
  const [salt, hash] = armazenado.split(":");
  const test = scryptSync(String(senha), salt, 64);
  const orig = Buffer.from(hash, "hex");
  return orig.length === test.length && timingSafeEqual(orig, test);
}

// Cria o admin inicial na primeira execução
export function seedAdmin() {
  const total = db.prepare("SELECT COUNT(*) n FROM usuarios").get().n;
  if (total > 0) return;
  const login = process.env.ADMIN_USER || "admin";
  const senha = process.env.ADMIN_PASSWORD || "banneg123";
  db.prepare(
    "INSERT INTO usuarios (login, nome, senha_hash, papel) VALUES (?,?,?, 'admin')"
  ).run(login, "Administrador", hashSenha(senha));
  console.log(`  👤 Usuário admin criado: login "${login}"${process.env.ADMIN_PASSWORD ? "" : ' / senha "banneg123" (troque em produção!)'}`);
}

export function autenticar(login, senha) {
  const u = db.prepare("SELECT * FROM usuarios WHERE login=? AND ativo=1").get(String(login || "").trim());
  if (!u || !verificarSenha(senha, u.senha_hash)) return null;
  return u;
}

export function criarSessao(u) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, {
    userId: u.id,
    login: u.login,
    nome: u.nome,
    papel: u.papel,
    exp: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function obterSessao(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function destruirSessao(token) {
  if (token) sessions.delete(token);
}

// Autenticação máquina-a-máquina por chave de API (header Authorization: Bearer <chave> ou x-api-key).
export function verificarApiKey(req) {
  const esperado = process.env.INTEGRACAO_API_KEY;
  if (!esperado) return false;
  let fornecido = "";
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) fornecido = auth.slice(7).trim();
  if (!fornecido && req.headers["x-api-key"]) fornecido = String(req.headers["x-api-key"]).trim();
  if (!fornecido) return false;
  const a = Buffer.from(fornecido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Parser simples de cookies (evita dependência extra)
export function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
