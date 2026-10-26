// Loaded before service imports, and as a preload in the database worker.
// This is an accidental-I/O tripwire, not an OS sandbox.
const { syncBuiltinESMExports } = require('node:module');
const { isMainThread, parentPort } = require('node:worker_threads');
const attempts = [];
function deny(operation) {
  return function () {
    attempts.push(operation);
    if (!isMainThread) parentPort?.postMessage({ performanceBlockedIO: operation });
    throw new Error(`Performance harness blocked external I/O: ${operation}`);
  };
}
globalThis.fetch = deny('fetch');
for (const [name, methods] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:tls', ['connect']], ['node:dgram', ['createSocket']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
]) {
  const module = require(name);
  for (const method of methods) module[method] = deny(`${name}.${method}`);
}
require('node:net').Socket.prototype.connect = deny('net.Socket.connect');
require('node:net').Server.prototype.listen = deny('net.Server.listen');
syncBuiltinESMExports();
module.exports = { attempts, deny };
