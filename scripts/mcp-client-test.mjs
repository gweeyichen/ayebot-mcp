// Real MCP client transcript: initialize, tools/list, tools/call each tool. Usage: node scripts/mcp-client-test.mjs <mcp-url>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || 'http://localhost:8080/mcp';
const client = new Client({ name: 'ayebot-mcp-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const v = client.getServerVersion();
console.log('# initialize ->', JSON.stringify(v), 'protocol', client.transport?.protocolVersion ?? '');
const { tools } = await client.listTools();
console.log('# tools/list ->', tools.map((t) => t.name).join(', '));
const calls = [
  ['count_buyers', { sector: 'healthcare', market: 'Malaysia' }],
  ['count_buyers', {}],
  ['count_buyers', { sector: 'nonsense' }],
  ['list_sectors_and_markets', {}],
  ['buyer_appetite_summary', { sector: 'F&B' }],
  ['how_to_sell_next_steps', {}],
];
let failures = 0;
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  const body = JSON.parse(text);
  const expectErr = args.sector === 'nonsense';
  const okAttr = /^Ayebot \(ayebot\.com\) buyer index, as at \d{4}-\d{2}-\d{2}$/.test(body.source) && body.url && body.note;
  const pass = expectErr ? r.isError === true : (!r.isError && okAttr);
  if (!pass) failures++;
  console.log(`# tools/call ${name} ${JSON.stringify(args)} -> ${pass ? 'PASS' : 'FAIL'}${r.isError ? ' (isError)' : ''}`);
  console.log(text.length > 1400 ? text.slice(0, 1400) + '\n  ...(truncated)' : text);
}
await client.close();
console.log(failures ? `FAILURES: ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
