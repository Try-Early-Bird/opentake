// Complete the mandatory prompt with a synthetic IPC result before unrelated UI
// tests. This never initiates OAuth, accesses credentials, or creates a DB connection.
export async function dismissConnectionPrompt(page, application) {
  const dialog = page.getByRole('dialog', { name: 'Connect a trading platform' });
  await dialog.waitFor();
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:status');
    ipcMain.handle('ai:status', () => [{ provider: 'chatgpt', status: 'connected' }, { provider: 'claude', status: 'disconnected' }]);
    ipcMain.removeHandler('connections:connect');
    ipcMain.handle('connections:connect', () => ({ ok: true, connection: { status: 'connected', checkedAt: null, accounts: [] } }));
  });
  await dialog.getByRole('button', { name: /^Robinhood/ }).click();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await dialog.waitFor({ state: 'hidden' });
}
