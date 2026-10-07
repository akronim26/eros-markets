import { PublicError } from "@/lib/public-error";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
let connection: DatabaseSync | undefined;
export function db() {
  if (connection) return connection;
  const path = resolve(/* turbopackIgnore: true */ process.env.AUTOMATION_DB || "var/automation.sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  connection = new DatabaseSync(path);
  connection.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, hash TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, user TEXT NOT NULL, wallet TEXT NOT NULL, engine TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, message TEXT, hash TEXT, created INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY, rule_id TEXT NOT NULL, block TEXT NOT NULL, message TEXT NOT NULL, hash TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS service (id TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS grants (wallet TEXT NOT NULL, signer TEXT NOT NULL, granted INTEGER NOT NULL, PRIMARY KEY(wallet, signer));`);
  const columns = connection.prepare("PRAGMA table_info(rules)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "checked")) connection.exec("ALTER TABLE rules ADD COLUMN checked INTEGER NOT NULL DEFAULT 0");
  return connection;
}
export function rateLimit(user: string) {
  const bucket = Math.floor(Date.now() / 60000), key = `${user}:${bucket}`;
  const row = db().prepare("INSERT INTO rate_limits(id,count) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count").get(key) as { count: number };
  if (row.count > 30) throw new PublicError("Too many requests. Try again in one minute.");
  db().prepare("DELETE FROM rate_limits WHERE id NOT LIKE ?").run(`%:${bucket}`);
}
