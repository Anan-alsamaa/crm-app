import { h, render } from 'preact';
import { Widget, type WidgetConfig } from './Widget.js';
import './styles.css';

/**
 * Embeddable entry. Host pages call:
 *   YijiChat.init({ gatewayUrl, token, locale });
 * The token is the Yiji-signed JWT issued by the host platform.
 */
function init(config: WidgetConfig): void {
  const mount = document.createElement('div');
  mount.id = 'yiji-chat-root';
  document.body.appendChild(mount);
  render(h(Widget, { config }), mount);
}

const YijiChat = { init };
// Expose on window for the IIFE build.
(globalThis as unknown as { YijiChat: typeof YijiChat }).YijiChat = YijiChat;

export { YijiChat, init };
