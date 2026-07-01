import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Preact runtime so we can assert what embed renders without a real
// component tree, and mock the Widget module + its CSS side-effect import.
const { hMock, renderMock, WidgetMock } = vi.hoisted(() => ({
  hMock: vi.fn((type: unknown, props: unknown) => ({ type, props })),
  renderMock: vi.fn(),
  WidgetMock: vi.fn(),
}));

vi.mock('preact', () => ({ h: hMock, render: renderMock }));
vi.mock('../src/Widget.js', () => ({ Widget: WidgetMock }));
vi.mock('../src/styles.css', () => ({}));

import { YijiChat, init } from '../src/embed.js';

const config = { gatewayUrl: 'https://gw', token: 'tok-1', locale: 'en' as const };

beforeEach(() => {
  document.body.innerHTML = '';
  hMock.mockClear();
  renderMock.mockClear();
  WidgetMock.mockClear();
});

describe('embed — window global', () => {
  it('exposes YijiChat.init on globalThis', () => {
    const g = globalThis as unknown as { YijiChat?: { init: unknown } };
    expect(g.YijiChat).toBeDefined();
    expect(typeof g.YijiChat!.init).toBe('function');
    expect(g.YijiChat!.init).toBe(init);
  });

  it('exports the same init from the module and the object', () => {
    expect(YijiChat.init).toBe(init);
  });
});

describe('embed — init', () => {
  it('creates a #yiji-chat-root mount appended to document.body', () => {
    init(config);
    const mount = document.getElementById('yiji-chat-root');
    expect(mount).not.toBeNull();
    expect(mount!.parentElement).toBe(document.body);
    expect(mount!.tagName).toBe('DIV');
  });

  it('renders the Widget with the passed config into the mount', () => {
    init(config);
    expect(hMock).toHaveBeenCalledTimes(1);
    expect(hMock).toHaveBeenCalledWith(WidgetMock, { config });

    expect(renderMock).toHaveBeenCalledTimes(1);
    const [vnode, target] = renderMock.mock.calls[0]!;
    expect(vnode).toEqual({ type: WidgetMock, props: { config } });
    expect(target).toBe(document.getElementById('yiji-chat-root'));
  });

  it('returns undefined (void)', () => {
    expect(init(config)).toBeUndefined();
  });

  it('forwards the exact config object reference through to the vnode props', () => {
    init(config);
    const props = hMock.mock.calls[0]![1] as { config: unknown };
    expect(props.config).toBe(config);
  });

  it('mounts again on a second call (unguarded — appends a second root)', () => {
    init(config);
    init(config);
    // Both mounts share the id; querySelectorAll shows two roots were appended.
    const roots = document.querySelectorAll('#yiji-chat-root');
    expect(roots.length).toBe(2);
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(WidgetMock).not.toHaveBeenCalled(); // Widget is mocked, only referenced
  });
});
