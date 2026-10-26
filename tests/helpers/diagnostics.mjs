import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read only diagnostics in the caller's disposable test profile, across UTC rotation.
export async function readHostLog(profile) {
  const directory = join(profile, 'logs', 'host');
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = names.filter(name => /^app\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  if (names.includes('app.jsonl')) files.unshift('app.jsonl');
  return (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8')))).join('');
}
