import type { ActivityJob } from '../../../shared/activity';

export const labels: Record<ActivityJob['state'], string> = {
  pending: 'Queued', running: 'Running', retrying: 'Retrying', completed: 'Completed', failed: 'Failed', needs_attention: 'Needs attention', cancelled: 'Cancelled',
};
export const errors: Record<string, string> = {
  reauth_required: 'Sign in again using the platform connect menu.', storage_locked: 'Sign in again using the platform connect menu.',
  transient: 'Temporary connection problem. Saved credentials have been kept.', cancelled: 'Interrupted; safe to retry.',
  host_restarted: 'Resuming after a host restart.', restored_backup: 'Backup restored. Sign in again to enable synchronization.', disconnected: 'Disconnected locally.', busy: 'Waiting for another connection operation.',
};
export function exactTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' });
}
export function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
