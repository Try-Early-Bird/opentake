/** Schema-history metadata only; never retain SQL, row data or raw database errors. */
export interface MigrationMismatch {
 version: number;
 storedChecksum: string;
 expectedChecksum: string | null;
 latestSupportedVersion: number;
}
export class MigrationHistoryError extends Error {
 constructor(readonly mismatch: MigrationMismatch) {
  super('Unsupported or modified database schema. Use a compatible app version.');
 }
}
export function validMigrationMismatch(value: unknown): value is MigrationMismatch {
 if (!value || typeof value !== 'object') return false;
 const v=value as MigrationMismatch;
 return Number.isSafeInteger(v.version)&&v.version>0&&Number.isSafeInteger(v.latestSupportedVersion)&&v.latestSupportedVersion>0
  &&typeof v.storedChecksum==='string'&&/^[a-f0-9]{64}$/.test(v.storedChecksum)
  &&(v.expectedChecksum===null||(typeof v.expectedChecksum==='string'&&/^[a-f0-9]{64}$/.test(v.expectedChecksum)));
}
export function migrationMismatchMessage(value: MigrationMismatch): string {
 return `Migration diagnostic: version ${value.version}; stored ${value.storedChecksum}; expected ${value.expectedChecksum??'not supported by this build'}; build supports through ${value.latestSupportedVersion}.`;
}
