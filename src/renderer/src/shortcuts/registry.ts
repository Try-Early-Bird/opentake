export const commands = [
  { id: 'dismiss', label: 'Close popup or Settings', scope: 'Overlay / Settings', editable: false },
  { id: 'search', label: 'Search markets and takes', scope: 'App', editable: true },
  { id: 'back', label: 'Go back', scope: 'Navigation', editable: true },
  { id: 'settings', label: 'Toggle Settings', scope: 'App', editable: true },
  { id: 'summary', label: 'Show keyboard shortcuts', scope: 'App', editable: true },
] as const;
export type CommandId = typeof commands[number]['id'];
export type Bindings = Record<CommandId, string>;
export function defaults(mac: boolean): Bindings {
  return { search: mac ? 'meta+k' : 'ctrl+k', dismiss: 'escape', back: mac ? 'meta+[' : 'alt+left', settings: mac ? 'meta+comma' : 'ctrl+comma', summary: mac ? 'meta+/' : 'ctrl+/' };
}
export function bindingError(id: CommandId, key: string, bindings: Bindings): string | undefined {
  if (id === 'dismiss') return 'Escape is reserved for dismissing dialogs.';
  if (!/^(?:(?:ctrl|meta|alt|shift)\+)*(?:[a-z0-9\[\]/]|comma|left|right|up|down|f(?:[1-9]|1[0-2]))$/.test(key)) return 'Use a modifier and a letter, number, arrow, or function key.';
  const parts = key.split('+');
  if (new Set(parts).size !== parts.length) return 'Duplicate modifier.';
  if (!parts.some(part => ['ctrl', 'meta', 'alt'].includes(part)) && !/^f\d+$/.test(key)) return 'Include Control, Command, or Alt to avoid interfering with typing.';
  if (/^(ctrl|meta)\+(?:[acvxyzqwrntl]|f4)$/.test(key) || /^(alt\+f4|meta\+h|meta\+m|f5|f11|f12)$/.test(key)) return 'That shortcut is reserved for the operating system or text editing.';
  if (Object.entries(bindings).some(([other, value]) => other !== id && value === key)) return 'That shortcut is already assigned.';
}
export function recordedBinding(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ',': 'comma' } as Record<string, string>)[event.key] ?? event.key.toLowerCase();
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return null;
  return [event.ctrlKey && 'ctrl', event.metaKey && 'meta', event.altKey && 'alt', event.shiftKey && 'shift', key].filter(Boolean).join('+');
}
export function displayBinding(binding: string): string {
  return binding.split('+').map(key => ({ meta: 'Cmd', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', escape: 'Esc', comma: ',', left: '←', right: '→', up: '↑', down: '↓' } as Record<string, string>)[key] ?? key.toUpperCase()).join(' + ');
}
export function loadBindings(raw: string | null, mac: boolean): Bindings {
  const result = defaults(mac);
  try {
    const saved = JSON.parse(raw ?? '{}');
    for (const command of commands) {
      const value = saved?.[command.id];
      if (command.editable && typeof value === 'string') result[command.id] = value;
    }
    // Adding search must not reset existing custom bindings that already use K.
    if (typeof saved?.search !== 'string' && Object.entries(result).some(([id, key]) => id !== 'search' && key === result.search)) {
      const modifier = mac ? 'meta' : 'ctrl';
      result.search = [`${modifier}+shift+k`, ...Array.from({ length: 12 }, (_, i) => `${modifier}+shift+f${i + 1}`)]
        .find(key => !bindingError('search', key, result))!;
    }
    // Validate together so valid swaps do not conflict with another command's default.
    if (commands.some(command => command.editable && bindingError(command.id, result[command.id], result))) return defaults(mac);
  } catch { /* Invalid stored settings fall back to safe defaults. */ }
  return result;
}
