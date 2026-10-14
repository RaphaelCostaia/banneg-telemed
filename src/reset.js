// Apaga TODOS os dados de vendas/cobranças (mantém usuários/login).
// Rodar:  npm run reset
import { db } from "./db.js";

db.exec(`
  DELETE FROM cobrancas;
  DELETE FROM dependentes;
  DELETE FROM vendas;
  DELETE FROM eventos;
  DELETE FROM sqlite_sequence WHERE name IN ('vendas','dependentes','cobrancas','eventos');
`);
console.log("🧹 Dados de vendas/cobranças apagados. Usuários e login preservados.");
