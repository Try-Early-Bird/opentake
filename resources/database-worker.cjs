// Private Node worker. No Electron APIs, credentials, network listeners or renderer access.
const { parentPort, workerData } = require('node:worker_threads');
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite({ ...workerData.options, dataDir: workerData.directory });
let chain = db.waitReady;
chain.then(() => parentPort.postMessage({ ready: true }), () => {
  parentPort.postMessage({ failed: true });
  parentPort.close();
});
parentPort.on('message', message => {
  chain = chain.then(async () => {
    try {
      let value;
      switch (message.method) {
        case 'query': value = await db.query(...message.args); break;
        case 'exec': value = await db.exec(...message.args); break;
        case 'dump': value = await db.dumpDataDir(...message.args); break;
        case 'close': await db.close(); break;
        default: throw new Error('Unsupported database operation');
      }
      parentPort.postMessage({ id: message.id, value });
      if (message.method === 'close') parentPort.close();
    } catch (error) {
      // SQL text, parameters, values and database paths never enter diagnostics.
      parentPort.postMessage({ id: message.id, error: true,
        code: typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined });
    }
  }).catch(() => {});
});
