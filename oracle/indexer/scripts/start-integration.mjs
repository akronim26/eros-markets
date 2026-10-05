// Resume the isolated local trading indexer without changing the original oracle database.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
const env = { ...process.env, ...parseEnv(readFileSync('.env', 'utf8')), ...parseEnv(readFileSync('.env.integration', 'utf8')) };
if (env.ENVIO_PG_DATABASE !== 'eros-trading' || env.ENVIO_PG_HOST !== 'localhost' || env.HASURA_GRAPHQL_ENDPOINT !== 'http://localhost:8081/v1/metadata') throw new Error('Expected the isolated local eros-trading database and Hasura on port 8081. Check .env.integration.');
const child = spawn('pnpm', ['exec', 'envio', 'start'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
