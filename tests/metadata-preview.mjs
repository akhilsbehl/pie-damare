// Run with PI_SDK_ROOT pointing at the installed pi-coding-agent package.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_SDK_ROOT;
assert.ok(root, 'PI_SDK_ROOT is required');
const sdk = await import(pathToFileURL(join(root, 'dist/index.js')));
const { Value } = await import(pathToFileURL(join(root, '../../typebox/build/value/index.mjs'))).catch(async () => {
  const { createRequire } = await import('node:module');
  return createRequire(join(root, 'package.json'))('typebox/value');
});
const source = await readFile(new URL('../damare.ts', import.meta.url), 'utf8');
// Evaluate the exact read/write/edit registration block, without loading background services.
const block = source.slice(source.indexOf('\tpi.registerTool({\n\t\t...createReadToolDefinition'), source.indexOf('\n\t// Find Tool'));
const tools = {};
const names = ['createReadToolDefinition', 'createWriteToolDefinition', 'createEditToolDefinition'];
new Function('pi', 'getBuiltInTools', ...names, 'process', block)(
  { registerTool: tool => tools[tool.name] = tool },
  cwd => ({ read: sdk.createReadTool(cwd), write: sdk.createWriteTool(cwd), edit: sdk.createEditTool(cwd) }),
  ...names.map(name => sdk[name]), process,
);
for (const name of ['read', 'write', 'edit']) {
  const expected = sdk[`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`](process.cwd());
  for (const key of ['constrainedSampling', 'renderShell', 'promptSnippet', 'promptGuidelines']) {
    assert.deepEqual(tools[name][key], expected[key], `${name}.${key}`);
  }
}
const edits = [{ oldText: 'before', newText: 'after' }];
for (const input of [JSON.stringify(edits), JSON.stringify(edits[0])]) {
  const args = tools.edit.prepareArguments({ path: 'test.txt', edits: input });
  assert.deepEqual(args.edits, edits);
  assert.equal(Value.Check(tools.edit.parameters, args), true);
}
assert.equal(Value.Check(tools.edit.parameters, { path: 'test.txt', edits: 'bad' }), false);
const cwd = await mkdtemp(join(tmpdir(), 'damare-test-'));
assert.notEqual(cwd, process.cwd());
try {
  await tools.write.execute('write', { path: 'test.txt', content: 'before' }, undefined, undefined, { cwd });
  await tools.edit.execute('edit', tools.edit.prepareArguments({ path: 'test.txt', edits: JSON.stringify(edits) }), undefined, undefined, { cwd });
  const result = await tools.read.execute('read', { path: 'test.txt' }, undefined, undefined, { cwd });
  assert.equal(result.content[0].text, 'after');
  assert.equal(await readFile(join(cwd, 'test.txt'), 'utf8'), 'after');
} finally { await rm(cwd, { recursive: true, force: true }); }
const extractSource = source.slice(source.indexOf('function getMessageText'), source.indexOf('function renderSubagentNotification')).replaceAll(': any', '').replaceAll(': string', '');
const extract = new Function(`${extractSource}; return getSubagentNotificationOutput;`)();
assert.equal(extract({ content: 'Background task completed: test\n\nactual output\n\nSession: hidden', details: { resultPreview: 'stale' } }), 'actual output');
assert.equal(extract({ content: [{ type: 'text', text: 'raw' }, { type: 'image' }, { type: 'text', text: 'output' }] }), 'raw\noutput');
assert.equal(extract({ content: 'Background tasks completed (2): test\n\n1. first\nfirst output\n2. second\nsecond output\nWorkflow run: hidden' }), 'first output\nsecond output');
assert.equal(extract({ content: 'Background task failed: test\n\nScheduled run from **schedule**\n\nfailure\nSession file: hidden' }), 'failure');
console.log('PASS: metadata, JSON edits preparation/schema, different execution cwd, and notification content extraction');
