import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class CodexWebSocketProxy extends EventEmitter {
  constructor({ listenUrl, targetUrl } = {}) {
    super();
    this.listenUrl = listenUrl;
    this.targetUrl = targetUrl;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    if (this.server) return;
    const url = new URL(this.listenUrl);
    if (url.protocol !== 'ws:') throw new Error(`unsupported proxy URL: ${this.listenUrl}`);

    this.server = createServer();
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    this.server.on('error', (err) => this.emit('error', err));

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(Number(url.port), url.hostname);
    });
  }

  close() {
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));

    const connection = new ProxyConnection({
      socket,
      targetUrl: this.targetUrl,
      onClientMessage: (message) => this.handleClientMessage(message),
      onServerMessage: (message, requestMethod) => this.handleServerMessage(connection, message, requestMethod),
      onClose: () => this.connections.delete(connection),
      onError: (err) => this.emit('error', err),
    });
    this.connections.add(connection);
    connection.start();
  }

  handleClientMessage(message) {
    const activeThreadId = observeClientMessage(message);
    if (activeThreadId) this.emit('active-thread', activeThreadId);
  }

  handleServerMessage(source, message, requestMethod) {
    const activeThreadId = observeServerMessage(message, requestMethod);
    if (activeThreadId) this.emit('active-thread', activeThreadId);
    if (isServerNotification(message)) {
      for (const connection of this.connections) {
        if (connection !== source) connection.sendText(message);
      }
    }
  }
}

class ProxyConnection {
  constructor({ socket, targetUrl, onClientMessage, onServerMessage, onClose, onError }) {
    this.socket = socket;
    this.targetUrl = targetUrl;
    this.onClientMessage = onClientMessage;
    this.onServerMessage = onServerMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
    this.pendingClientMessages = [];
    this.pendingRequests = new Map();
    this.backendOpen = false;
  }

  start() {
    this.backend = new WebSocket(this.targetUrl);
    this.backend.onopen = () => {
      this.backendOpen = true;
      for (const message of this.pendingClientMessages.splice(0)) this.backend.send(message);
    };
    this.backend.onmessage = (event) => {
      const message = String(event.data);
      const parsed = parseJsonObject(message);
      const requestMethod = parsed?.id === undefined ? null : this.pendingRequests.get(parsed.id);
      if (parsed?.id !== undefined) this.pendingRequests.delete(parsed.id);
      this.onServerMessage(message, requestMethod);
      sendFrame(this.socket, 0x1, Buffer.from(message));
    };
    this.backend.onerror = () => {};
    this.backend.onclose = () => this.close();

    this.socket.on('data', (chunk) => this.read(chunk));
    this.socket.on('error', (err) => {
      this.onError(err);
      this.close();
    });
    this.socket.on('close', () => this.close());
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = readFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.slice(frame.bytes);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        sendFrame(this.socket, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode !== 0x1) continue;

      const message = frame.payload.toString('utf8');
      const parsed = parseJsonObject(message);
      if (parsed?.id !== undefined && parsed?.method) {
        this.pendingRequests.set(parsed.id, parsed.method);
      }
      this.onClientMessage(message);
      if (this.backendOpen) {
        this.backend.send(message);
      } else {
        this.pendingClientMessages.push(message);
      }
    }
  }

  sendText(message) {
    if (this.closed) return;
    sendFrame(this.socket, 0x1, Buffer.from(message));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.backend?.close();
    } catch {
      // Best effort close.
    }
    try {
      this.socket.end();
    } catch {
      // Best effort close.
    }
    this.onClose();
  }
}

export function observeClientMessage(message) {
  const parsed = parseJsonObject(message);
  if (!parsed) return null;
  if (parsed.method === 'turn/start' && parsed.params?.threadId) return parsed.params.threadId;
  if (parsed.method === 'turn/steer' && parsed.params?.threadId) return parsed.params.threadId;
  if (parsed.method === 'turn/interrupt' && parsed.params?.threadId) return parsed.params.threadId;
  return null;
}

export function observeServerMessage(message, requestMethod = null) {
  const parsed = parseJsonObject(message);
  if (!parsed) return null;
  if ((requestMethod === 'thread/start' || requestMethod === 'thread/resume') && parsed.result?.thread?.id) {
    return parsed.result.thread.id;
  }
  if (parsed.method === 'thread/started' && parsed.params?.thread?.id) return parsed.params.thread.id;
  if (parsed.method === 'turn/started' && parsed.params?.threadId) return parsed.params.threadId;
  if (parsed.method === 'thread/status/changed' && parsed.params?.threadId) return parsed.params.threadId;
  return null;
}

export function isServerNotification(message) {
  const parsed = parseJsonObject(message);
  return Boolean(parsed && parsed.id === undefined && typeof parsed.method === 'string');
}

function parseJsonObject(message) {
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
    length = Number(bigLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, bytes: offset + length };
}

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
