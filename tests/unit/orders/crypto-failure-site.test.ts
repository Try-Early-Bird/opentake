import {test,expect} from 'vitest';
import {cryptoFailureSite} from '../../../src/main/orders/crypto-failure-site';
test('diagnostics expose only bounded bundled source coordinates, never messages or private paths',()=>{
 const error=Error('private-message');error.stack='Error: private-message\n    at preview (/Users/private-owner/repo/out/main/index.js:12345:17)\n    at secret (/private/token:3:4)';
 expect(cryptoFailureSite(error)).toBe('index.js:12345:17');
 error.stack='Error: /secret/out/main/index.js:999:1\n    at fetch (https://secret.example/token:1:2)';expect(cryptoFailureSite(error)).toBeNull();
 expect(cryptoFailureSite({stack:'secret'})).toBeNull();
});
