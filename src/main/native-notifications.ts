import { Notification } from 'electron';
import type { NativeAlert } from './notifications';

/** No broker/session access here. Keep objects alive until click/close. */
export function createNativeNotifications(icon: string) {
  const live = new Set<Notification>();
  return {
    deliver(alert: NativeAlert) {
      if (!Notification.isSupported()) { alert.failed(); return; }
      const notification = new Notification({ title: alert.title, body: alert.body, icon });
      live.add(notification);
      notification.once('click', () => { live.delete(notification); alert.click(); });
      notification.once('close', () => live.delete(notification));
      notification.once('failed', () => { live.delete(notification); alert.failed(); });
      notification.show();
    },
    close() { for (const notification of live) notification.close(); live.clear(); },
  };
}
