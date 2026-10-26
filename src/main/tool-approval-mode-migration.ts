// Migration 12 has already run in development profiles; rename append-only.
export const toolApprovalModeMigration = { version: 13, name: 'Tool history approval mode column', sql: `
ALTER TABLE tool_invocations RENAME COLUMN "authorization" TO approval_mode;
` };
