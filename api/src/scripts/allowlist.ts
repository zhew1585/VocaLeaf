// Operator script for the invite allowlist (PRD 6.2). Runs inside the api container, which has DATABASE_URL:
//   docker compose exec api node dist/scripts/allowlist.js add  <email>... --by <operator>
//   docker compose exec api node dist/scripts/allowlist.js remove <email>... --by <operator>
//   docker compose exec api node dist/scripts/allowlist.js list
// add and remove write each email to the audit log with the operator named by --by.
import { addToAllowlist, listAllowlist, parseEmails, removeFromAllowlist } from "../allowlist.js";
import { connectDb } from "../db/client.js";

const USAGE = "usage: allowlist.js add|remove <email>... --by <operator>\n       allowlist.js list";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const byAt = rest.indexOf("--by");
const actor = byAt >= 0 ? rest[byAt + 1]?.trim() : undefined;
const emails = byAt >= 0 ? rest.filter((_, i) => i !== byAt && i !== byAt + 1) : rest;
const url = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");

if (command === "list") {
  const db = await connectDb(url);
  for (const row of await listAllowlist(db)) console.log(`${row.email}\t${row.createdAt.toISOString()}`);
} else if (command === "add" || command === "remove") {
  if (!actor) fail(`--by <operator> is required: the audit log records who made the change\n${USAGE}`);
  if (emails.length === 0) fail(USAGE);
  let parsed: string[];
  try {
    parsed = parseEmails(emails);
  } catch (err) {
    fail((err as Error).message);
  }
  const db = await connectDb(url);
  const changes = await (command === "add" ? addToAllowlist : removeFromAllowlist)(db, parsed, actor);
  for (const { email, result } of changes) console.log(`${email}\t${result}`);
} else {
  fail(USAGE);
}
process.exit(0);
