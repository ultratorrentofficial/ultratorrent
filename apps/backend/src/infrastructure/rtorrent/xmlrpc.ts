import { XMLParser } from 'fast-xml-parser';

/**
 * Minimal, dependency-light XML-RPC codec tailored for rTorrent.
 *
 * rTorrent speaks XML-RPC (commonly tunnelled over SCGI). We hand-encode
 * requests for full control over 64-bit integer typing (`i8`) and parse
 * responses into plain JS values.
 */

/** Wrapper marking a buffer to be transmitted as an XML-RPC <base64> value. */
export class XmlRpcBase64 {
  constructor(public readonly buffer: Buffer) {}
}

export type XmlRpcValue =
  | string
  | number
  | boolean
  | XmlRpcBase64
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

export class XmlRpcFault extends Error {
  constructor(
    public readonly faultCode: number,
    public readonly faultString: string,
  ) {
    super(`XML-RPC fault ${faultCode}: ${faultString}`);
    this.name = 'XmlRpcFault';
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function encodeValue(value: XmlRpcValue): string {
  if (typeof value === 'string') {
    return `<value><string>${escapeXml(value)}</string></value>`;
  }
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      // rTorrent expects 64-bit ints for most numeric commands.
      return `<value><i8>${value}</i8></value>`;
    }
    return `<value><double>${value}</double></value>`;
  }
  if (value instanceof XmlRpcBase64) {
    return `<value><base64>${value.buffer.toString('base64')}</base64></value>`;
  }
  if (Array.isArray(value)) {
    const items = value.map(encodeValue).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  // struct
  const members = Object.entries(value)
    .map(
      ([k, v]) => `<member><name>${escapeXml(k)}</name>${encodeValue(v)}</member>`,
    )
    .join('');
  return `<value><struct>${members}</struct></value>`;
}

export function buildMethodCall(
  methodName: string,
  params: XmlRpcValue[],
): string {
  const encodedParams = params
    .map((p) => `<param>${encodeValue(p)}</param>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<methodCall><methodName>${escapeXml(methodName)}</methodName>` +
    `<params>${encodedParams}</params></methodCall>`
  );
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep raw strings; we coerce by type tag
  trimValues: true,
  isArray: (name) => ['value', 'member', 'param', 'data'].includes(name),
});

function decodeValueNode(node: any): XmlRpcValue {
  if (node === undefined || node === null) return '';
  // A <value> node may carry a typed child or bare text.
  if (typeof node === 'string') return node;

  if ('string' in node) return String(node.string ?? '');
  if ('i4' in node) return parseInt(String(node.i4), 10);
  if ('int' in node) return parseInt(String(node.int), 10);
  if ('i8' in node) return parseInt(String(node.i8), 10);
  if ('double' in node) return parseFloat(String(node.double));
  if ('boolean' in node) return String(node.boolean) === '1';
  if ('dateTime.iso8601' in node) return String(node['dateTime.iso8601']);
  if ('base64' in node) return String(node.base64);

  if ('array' in node) {
    const data = node.array?.data?.[0];
    const values = data?.value ?? [];
    return (Array.isArray(values) ? values : [values]).map(decodeValueNode);
  }

  if ('struct' in node) {
    const members = node.struct?.member ?? [];
    const out: Record<string, XmlRpcValue> = {};
    for (const m of Array.isArray(members) ? members : [members]) {
      out[String(m.name)] = decodeValueNode(m.value?.[0] ?? m.value);
    }
    return out;
  }

  // Bare value text (untyped == string per spec)
  if ('#text' in node) return String(node['#text']);
  return '';
}

export function parseMethodResponse(xml: string): XmlRpcValue {
  const doc = parser.parse(xml);
  const response = doc.methodResponse;
  if (!response) {
    throw new Error('Malformed XML-RPC response: missing methodResponse');
  }

  if (response.fault) {
    const faultStruct = decodeValueNode(
      response.fault.value?.[0] ?? response.fault.value,
    ) as Record<string, XmlRpcValue>;
    throw new XmlRpcFault(
      Number(faultStruct.faultCode ?? -1),
      String(faultStruct.faultString ?? 'Unknown fault'),
    );
  }

  const param = response.params?.param?.[0];
  if (!param) return '';
  return decodeValueNode(param.value?.[0] ?? param.value);
}
