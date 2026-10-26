import { describe, expect, it } from 'vitest';
import { bindingError, defaults, loadBindings, recordedBinding } from '../../src/renderer/src/shortcuts/registry';

describe('shortcut registry', () => {
  it('uses platform-specific defaults', () => {
    expect(defaults(true).search).toBe('meta+k');
    expect(defaults(false).search).toBe('ctrl+k');
    expect(defaults(true).back).toBe('meta+[');
    expect(defaults(false).back).toBe('alt+left');
  });
  it('adds search without resetting existing custom K bindings', () => {
    const saved = loadBindings(JSON.stringify({ back: 'meta+k', settings: 'meta+shift+k' }), true);
    expect(saved.back).toBe('meta+k'); expect(saved.settings).toBe('meta+shift+k');
    expect(saved.search).toBe('meta+shift+f1');
    expect(bindingError('search', saved.search, saved)).toBeUndefined();
  });
  it('rejects conflicts, unmodified typing, and reserved keys', () => {
    expect(bindingError('back', 'meta+comma', defaults(true))).toMatch(/already assigned/);
    expect(bindingError('back', 'a', defaults(true))).toMatch(/Include/);
    expect(bindingError('back', 'meta+q', defaults(true))).toMatch(/reserved/);
    expect(bindingError('back', 'ctrl+shift+k', defaults(true))).toBeUndefined();
  });
  it('loads valid preferences and retains fixed Escape', () => {
    expect(loadBindings(JSON.stringify({ back: 'ctrl+shift+k', dismiss: 'ctrl+d' }), true)).toEqual({ ...defaults(true), back: 'ctrl+shift+k' });
    expect(loadBindings('broken', false)).toEqual(defaults(false));
    expect(loadBindings(JSON.stringify({ back: 'meta+comma', settings: 'meta+[' }), true)).toEqual({ ...defaults(true), back: 'meta+comma', settings: 'meta+[' });
  });
  it('normalizes captured keys', () => {
    expect(recordedBinding({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false })).toBe('alt+left');
    expect(recordedBinding({ key: 'K', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('ctrl+shift+k');
  });
});
