import { readFileSync } from 'node:fs';

// The append-only checksum fixture is the independent expected migration lineage.
export const migrationVersions = JSON.parse(readFileSync(new URL('../fixtures/migration-checksums.json', import.meta.url), 'utf8'))
  .map(item => item.version).sort((a, b) => b - a);
