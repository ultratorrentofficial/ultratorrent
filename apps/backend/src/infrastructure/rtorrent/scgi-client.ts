import * as net from 'node:net';
import {
  buildMethodCall,
  parseMethodResponse,
  XmlRpcValue,
} from './xmlrpc';

export interface RtorrentTransportConfig {
  /** scgi-tcp | scgi-unix | http */
  mode: 'scgi-tcp' | 'scgi-unix' | 'http';
  host?: string;
  port?: number;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
}

export interface RtorrentTransport {
  call(method: string, params?: XmlRpcValue[]): Promise<XmlRpcValue>;
}

/** Encode an SCGI request: netstring(headers) + body. */
function encodeScgiRequest(body: Buffer): Buffer {
  const headers =
    `CONTENT_LENGTH\0${body.length}\0` +
    `SCGI\x001\x00` +
    `REQUEST_METHOD\0POST\0` +
    `CONTENT_TYPE\0text/xml\0`;
  const headerBuf = Buffer.from(headers, 'utf8');
  const netstring = Buffer.concat([
    Buffer.from(`${headerBuf.length}:`, 'utf8'),
    headerBuf,
    Buffer.from(',', 'utf8'),
  ]);
  return Buffer.concat([netstring, body]);
}

/** Strip the SCGI/HTTP-style response headers, returning the XML body. */
function extractBody(raw: Buffer): string {
  const text = raw.toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  if (sep !== -1) return text.slice(sep + 4);
  const sep2 = text.indexOf('\n\n');
  if (sep2 !== -1) return text.slice(sep2 + 2);
  return text;
}

class ScgiTransport implements RtorrentTransport {
  constructor(private readonly cfg: RtorrentTransportConfig) {}

  call(method: string, params: XmlRpcValue[] = []): Promise<XmlRpcValue> {
    const xml = buildMethodCall(method, params);
    const payload = encodeScgiRequest(Buffer.from(xml, 'utf8'));
    const timeout = this.cfg.timeoutMs ?? 15000;

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };

      const connectOpts =
        this.cfg.mode === 'scgi-unix'
          ? { path: this.cfg.socketPath as string }
          : { host: this.cfg.host ?? '127.0.0.1', port: this.cfg.port ?? 5000 };

      const socket = net.connect(connectOpts as net.NetConnectOpts, () => {
        socket.write(payload);
      });
      socket.setTimeout(timeout, () =>
        onError(new Error(`rTorrent SCGI timeout after ${timeout}ms`)),
      );
      socket.on('data', (d) => chunks.push(d));
      socket.on('error', onError);
      socket.on('end', () => {
        try {
          const body = extractBody(Buffer.concat(chunks));
          resolve(parseMethodResponse(body));
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  }
}

class HttpTransport implements RtorrentTransport {
  constructor(private readonly cfg: RtorrentTransportConfig) {}

  async call(method: string, params: XmlRpcValue[] = []): Promise<XmlRpcValue> {
    const xml = buildMethodCall(method, params);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 15000,
    );
    try {
      const res = await fetch(this.cfg.url as string, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: xml,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`rTorrent HTTP transport returned ${res.status}`);
      }
      return parseMethodResponse(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRtorrentTransport(
  cfg: RtorrentTransportConfig,
): RtorrentTransport {
  switch (cfg.mode) {
    case 'http':
      return new HttpTransport(cfg);
    case 'scgi-unix':
    case 'scgi-tcp':
      return new ScgiTransport(cfg);
    default:
      throw new Error(`Unknown rTorrent transport mode: ${cfg.mode}`);
  }
}
