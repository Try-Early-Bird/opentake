export const takePermissionModeMigration = { version: 19, name: 'Take Auto and Ask permission modes', sql: `
ALTER TABLE takes ADD COLUMN permission_mode text NOT NULL DEFAULT 'auto' CHECK (permission_mode IN ('auto','ask'));
` };
