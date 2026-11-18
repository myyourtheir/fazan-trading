export async function watchSocket<Message>(
  path: string,
  removed: Promise<void>,
  handlers: { onConnect?: () => void; onMessage: (message: Message) => void; onClose?: (code: number) => void },
) {
  let socket: WebSocket | undefined;
  let retry: number | undefined;
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  function connect() {
    handlers.onConnect?.();
    const ws = socket = new WebSocket(url);
    ws.onmessage = ({ data }) => {
      try {
        handlers.onMessage(JSON.parse(data) as Message);
      } catch { /* Ignore invalid messages. */ }
    };
    ws.onclose = ({ code }) => {
      handlers.onClose?.(code);
      if (code !== 1008) retry = window.setTimeout(connect, 2_000);
    };
  }

  connect();
  await removed;
  window.clearTimeout(retry);
  if (socket) {
    socket.onmessage = socket.onclose = null;
    socket.close();
  }
}
