import { spawn } from 'node:child_process'
import { checkCurrentConfig } from './current-config.mjs'

const command = process.argv[2]
if (!['codegen', 'dev', 'start'].includes(command)) throw new Error('Expected codegen, dev or start')
if (process.env.ENVIO_DEPLOYMENT && process.env.ENVIO_DEPLOYMENT !== 'current') throw new Error('Default commands require ENVIO_DEPLOYMENT=current; historical replay requires an explicit archived config and direct Envio invocation')
checkCurrentConfig()
const child = spawn('envio', [command], { stdio: 'inherit', env: { ...process.env, ENVIO_DEPLOYMENT: 'current' } })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
