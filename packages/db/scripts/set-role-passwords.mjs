// Sets the app_api / app_worker role passwords from the environment.
// Run after migrations (which create the roles password-less). Used by
// `pnpm db:roles` in dev and by bootstrap.sh in prod — credentials come from
// $APP_API_PASSWORD / $APP_WORKER_PASSWORD, never from committed code.
import { Client } from "pg";

const { DATABASE_URL, APP_API_PASSWORD, APP_WORKER_PASSWORD } = process.env;

if (!DATABASE_URL) {
  console.error("set-role-passwords: DATABASE_URL (admin) is required");
  process.exit(1);
}
if (!APP_API_PASSWORD || !APP_WORKER_PASSWORD) {
  console.error("set-role-passwords: APP_API_PASSWORD and APP_WORKER_PASSWORD are required");
  process.exit(1);
}

// ALTER ROLE ... PASSWORD takes a string literal (no bind parameters), so we
// inline and escape single quotes. Values are our own env, not untrusted input.
const lit = (s) => `'${s.replace(/'/g, "''")}'`;

const c = new Client({ connectionString: DATABASE_URL });
try {
  await c.connect();
  await c.query(`ALTER ROLE app_api PASSWORD ${lit(APP_API_PASSWORD)}`);
  await c.query(`ALTER ROLE app_worker PASSWORD ${lit(APP_WORKER_PASSWORD)}`);
  console.log("set-role-passwords: app_api + app_worker passwords applied from env");
} catch (e) {
  console.error("set-role-passwords: failed —", e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
