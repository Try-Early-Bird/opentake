import { beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const fake = vi.hoisted(() => ({ supported: true, instances: [] as any[] }));
vi.mock('electron', () => ({ Notification: class extends EventEmitter {
  static isSupported() { return fake.supported; }
  options: unknown;
  show = vi.fn();
  close = vi.fn(() => this.emit('close'));
  constructor(options: unknown) { super(); this.options = options; fake.instances.push(this); }
} }));
import { createNativeNotifications } from '../../src/main/native-notifications';
beforeEach(() => { fake.supported = true; fake.instances = []; });
test('native delivery retains click and failure handlers, and closes outstanding alerts', () => {
  const native = createNativeNotifications('icon.png');
  const click = vi.fn(), failed = vi.fn();
  native.deliver({ title: 'Attention', body: 'Review the request', click, failed });
  expect(fake.instances[0].options).toEqual({ title: 'Attention', body: 'Review the request', icon: 'icon.png' });
  expect(fake.instances[0].show).toHaveBeenCalledOnce();
  fake.instances[0].emit('click'); expect(click).toHaveBeenCalledOnce();
  native.deliver({ title: 'Second', body: '', click, failed });
  fake.instances[1].emit('failed'); expect(failed).toHaveBeenCalledOnce();
  native.deliver({ title: 'Third', body: '', click, failed });
  native.close(); expect(fake.instances[2].close).toHaveBeenCalledOnce();
});
test('unsupported native alerts fail once without constructing an OS notification', () => {
  const failed = vi.fn(); fake.supported = false;
  createNativeNotifications('icon.png').deliver({ title: 'Attention', body: '', click: vi.fn(), failed });
  expect(failed).toHaveBeenCalledOnce(); expect(fake.instances).toHaveLength(0);
});
