import {
  buildMethodCall,
  parseMethodResponse,
  XmlRpcFault,
} from './xmlrpc';

describe('xmlrpc codec', () => {
  it('builds a method call with typed params', () => {
    const xml = buildMethodCall('d.multicall2', ['', 'main', 42]);
    expect(xml).toContain('<methodName>d.multicall2</methodName>');
    expect(xml).toContain('<string>main</string>');
    expect(xml).toContain('<i8>42</i8>');
  });

  it('escapes XML special characters in strings', () => {
    const xml = buildMethodCall('m', ['a & b < c']);
    expect(xml).toContain('a &amp; b &lt; c');
  });

  it('parses a scalar response', () => {
    const res = parseMethodResponse(
      '<?xml version="1.0"?><methodResponse><params><param><value><i8>123</i8></value></param></params></methodResponse>',
    );
    expect(res).toBe(123);
  });

  it('parses a multicall array of arrays', () => {
    const xml = `<?xml version="1.0"?><methodResponse><params><param><value><array><data>
      <value><array><data><value><string>abc</string></value><value><i8>10</i8></value></data></array></value>
      <value><array><data><value><string>def</string></value><value><i8>20</i8></value></data></array></value>
    </data></array></value></param></params></methodResponse>`;
    const res = parseMethodResponse(xml) as unknown[][];
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual(['abc', 10]);
    expect(res[1]).toEqual(['def', 20]);
  });

  it('throws XmlRpcFault on a fault response', () => {
    const xml = `<?xml version="1.0"?><methodResponse><fault><value><struct>
      <member><name>faultCode</name><value><i4>-501</i4></value></member>
      <member><name>faultString</name><value><string>Method not found</string></value></member>
    </struct></value></fault></methodResponse>`;
    expect(() => parseMethodResponse(xml)).toThrow(XmlRpcFault);
  });
});
