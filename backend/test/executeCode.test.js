const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

process.env.SANDBOX_RUN_TIMEOUT_MS = '2000';
process.env.GROQ_API_KEY = 'super-secret-key-for-test';
const { executeCode, executeTests, javaMainClass, ExecutionError } = require('../src/executeCode');
const config = require('../src/config');

const available = (cmd, args = ['--version']) => {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};
const hasPython = available(config.sandbox.pythonBin);
const hasGpp = available('g++');
const hasJava = available('javac', ['-version']);

test('python: runs with stdin', { skip: !hasPython }, async () => {
  assert.equal((await executeCode('py', 'print(input()[::-1])', 'lumen')).trim(), 'nemul');
});

test('python: server secrets are not visible to programs', { skip: !hasPython }, async () => {
  const out = await executeCode('py', 'import os\nprint(os.environ.get("GROQ_API_KEY"))');
  assert.equal(out.trim(), 'None');
});

test('python: infinite loop hits the time limit', { skip: !hasPython }, async () => {
  const [result] = await executeTests('py', 'while True: pass', ['']);
  assert.equal(result.success, false);
  assert.match(result.error, /Time Limit Exceeded/);
});

test('python: program that ignores large stdin does not crash the server', { skip: !hasPython }, async () => {
  const [result] = await executeTests('py', 'pass', ['x'.repeat(300000)]);
  assert.equal(result.success, true);
});

test('python: runaway output is cut off', { skip: !hasPython }, async () => {
  const [result] = await executeTests('py', 'while True: print("x" * 1000)', ['']);
  assert.match(result.error, /Output Limit Exceeded/);
});

test('python: runtime errors are reported', { skip: !hasPython }, async () => {
  const [result] = await executeTests('py', 'raise ValueError("boom")', ['']);
  assert.equal(result.success, false);
  assert.match(result.error, /ValueError: boom/);
});

test('cpp: compiles once and runs every test case', { skip: !hasGpp }, async () => {
  const code = '#include <iostream>\nint main(){long a,b; std::cin>>a>>b; std::cout<<a+b;}';
  const results = await executeTests('cpp', code, ['1 2', '40 2']);
  assert.deepEqual(results.map((r) => r.output), ['3', '42']);
});

test('cpp: compile errors throw without leaking sandbox paths', { skip: !hasGpp }, async () => {
  await assert.rejects(executeTests('cpp', 'int main( {', ['']), (err) => {
    assert.ok(err instanceof ExecutionError);
    assert.equal(err.kind, 'compile');
    assert.doesNotMatch(err.message, /job-/);
    return true;
  });
});

test('java: any public class name works', { skip: !hasJava }, async () => {
  const code = 'public class Solution { public static void main(String[] a){ System.out.println("ok"); } }';
  assert.equal((await executeCode('java', code)).trim(), 'ok');
});

test('javaMainClass detects the entry class', () => {
  assert.equal(javaMainClass('public final class Foo { }'), 'Foo');
  assert.equal(javaMainClass('class Helper {}\nclass Solution { public static void main(String[] a) {} }'), 'Solution');
  assert.equal(javaMainClass('// nothing here'), 'Main');
});

test('unsupported languages are rejected', async () => {
  await assert.rejects(executeCode('rust', 'fn main(){}'), /Unsupported language/);
});
