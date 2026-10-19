const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const config = require('./config');

const cfg = config.sandbox;

class ExecutionError extends Error {
  constructor(message, kind = 'runtime', status = 400) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Sandbox mode detection                                              */
/* ------------------------------------------------------------------ */

const hasBinary = (name) => {
  try {
    return spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};

const canHarden = () =>
  process.platform === 'linux' &&
  typeof process.getuid === 'function' &&
  process.getuid() === 0 &&
  hasBinary('prlimit') &&
  hasBinary('setpriv');

let resolvedMode = null;
const sandboxMode = () => {
  if (resolvedMode) return resolvedMode;
  if (cfg.mode === 'hardened' || cfg.mode === 'none') {
    resolvedMode = cfg.mode;
  } else {
    resolvedMode = canHarden() ? 'hardened' : 'none';
  }
  return resolvedMode;
};

/**
 * Called once at startup. Refuses to run untrusted code without isolation in
 * production unless explicitly overridden.
 */
const assertSandboxReady = () => {
  const mode = sandboxMode();
  if (mode === 'hardened' && !canHarden()) {
    throw new Error(
      'SANDBOX_MODE=hardened requires Linux, root inside the container, and the prlimit/setpriv tools (util-linux).'
    );
  }
  if (mode === 'none') {
    if (config.isProduction && !cfg.allowUnsafe) {
      throw new Error(
        'Refusing to start: no execution sandbox is available in production. Run inside the provided Docker image, ' +
          'or set ALLOW_UNSAFE_EXECUTION=true if you understand the risk.'
      );
    }
    console.warn(
      '[sandbox] Running WITHOUT isolation (local development mode). Submitted code runs as your user. Do not expose this server publicly.'
    );
  } else {
    console.log(`[sandbox] Hardened mode: programs run as uid ${cfg.uid} with resource limits.`);
  }
  return mode;
};

/* ------------------------------------------------------------------ */
/* Concurrency control                                                 */
/* ------------------------------------------------------------------ */

class Semaphore {
  constructor(max, maxQueue) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new ExecutionError('Server is busy running other programs. Please try again in a moment.', 'busy', 503);
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const slots = new Semaphore(cfg.maxConcurrency, cfg.maxQueue);

/* ------------------------------------------------------------------ */
/* Process runner                                                      */
/* ------------------------------------------------------------------ */

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// Children never inherit the server's environment, so API keys and database
// credentials are not visible to submitted programs.
const childEnv = (workDir) => {
  const env = { HOME: workDir, TMPDIR: workDir, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
  if (sandboxMode() === 'hardened') {
    env.PATH = SAFE_PATH;
  } else {
    env.PATH = process.env.PATH || SAFE_PATH;
    if (process.platform === 'win32') {
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'ComSpec']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      env.TEMP = workDir;
      env.TMP = workDir;
    }
  }
  return env;
};

/**
 * Wraps a command with resource limits (prlimit) and a privilege drop
 * (setpriv) when running in hardened mode.
 */
const wrapCommand = (command, args, { timeoutMs, memoryMb, limitAddressSpace }) => {
  if (sandboxMode() !== 'hardened') return [command, args];

  const cpuSeconds = Math.ceil(timeoutMs / 1000) + 1;
  const limits = [
    `--cpu=${cpuSeconds}`,
    `--nproc=${cfg.maxProcesses}`,
    `--fsize=${cfg.maxFileSizeMb * 1024 * 1024}`,
    '--nofile=128',
    '--core=0',
  ];
  // The JVM reserves large virtual ranges up front, so Java relies on -Xmx
  // instead of an address-space limit.
  if (limitAddressSpace !== false) limits.push(`--as=${memoryMb * 1024 * 1024}`);

  return [
    'prlimit',
    [
      ...limits,
      '--',
      'setpriv',
      `--reuid=${cfg.uid}`,
      `--regid=${cfg.gid}`,
      '--clear-groups',
      '--no-new-privs',
      '--',
      command,
      ...args,
    ],
  ];
};

const runProcess = ({ command, args, cwd, input = '', timeoutMs, memoryMb = cfg.memoryLimitMb, limitAddressSpace }) =>
  new Promise((resolve) => {
    const [cmd, cmdArgs] = wrapCommand(command, args, { timeoutMs, memoryMb, limitAddressSpace });
    const startedAt = process.hrtime.bigint();
    const useProcessGroup = process.platform !== 'win32';

    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd, env: childEnv(cwd), detached: useProcessGroup, windowsHide: true });
    } catch (err) {
      resolve({ spawnError: err.message, stdout: '', stderr: '', exitCode: null, signal: null, durationMs: 0 });
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    // Kill the whole process group so forked children die with the program.
    const killTree = () => {
      try {
        if (useProcessGroup) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const collect = (target) => (chunk) => {
      if (outputLimitExceeded) return;
      let text = chunk.toString();
      bytes += chunk.length;
      if (bytes > cfg.maxOutputBytes) {
        outputLimitExceeded = true;
        text = text.slice(0, Math.max(0, text.length - (bytes - cfg.maxOutputBytes)));
        killTree();
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        ...extra,
      });
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (err) => finish({ spawnError: err.message, exitCode: null, signal: null }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }));

    // A program that exits without reading stdin causes EPIPE here; without a
    // handler that error would crash the whole server.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

/* ------------------------------------------------------------------ */
/* Workspace helpers                                                   */
/* ------------------------------------------------------------------ */

const workRoot = () => cfg.workRoot || (sandboxMode() === 'hardened' ? '/sandbox' : path.join(os.tmpdir(), 'codelumen'));

const createJobDir = async () => {
  const root = workRoot();
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'job-'));
  if (sandboxMode() === 'hardened') {
    await fs.chown(dir, cfg.uid, cfg.gid);
    await fs.chmod(dir, 0o700);
  }
  return dir;
};

const writeSource = async (dir, fileName, code) => {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, code, { mode: 0o600 });
  if (sandboxMode() === 'hardened') await fs.chown(filePath, cfg.uid, cfg.gid);
  return filePath;
};

const removeJobDir = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

// Hide sandbox paths like /sandbox/job-x1y2/main.cpp from compiler messages.
const scrubPaths = (text, dir) => (text || '').split(dir + path.sep).join('').split(dir).join('.');

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

const normalizeLanguage = (language) => {
  const key = String(language || '').toLowerCase();
  if (key === 'py' || key === 'python') return 'py';
  if (key === 'cpp' || key === 'c++') return 'cpp';
  if (key === 'java') return 'java';
  throw new ExecutionError(`Unsupported language: ${language}. Use cpp, java, or py.`, 'validation');
};

const JAVA_IDENT = '[A-Za-z_$][\\w$]*';

/**
 * Java requires the file name to match the public class. Detect it instead of
 * forcing users to name their class "Main".
 */
const javaMainClass = (code) => {
  const publicClass = code.match(new RegExp(`public\\s+(?:final\\s+|abstract\\s+)*class\\s+(${JAVA_IDENT})`));
  if (publicClass) return publicClass[1];
  const mainAt = code.search(/static\s+void\s+main\s*\(/);
  const head = mainAt === -1 ? code : code.slice(0, mainAt);
  const classes = [...head.matchAll(new RegExp(`\\bclass\\s+(${JAVA_IDENT})`, 'g'))];
  return classes.length ? classes[classes.length - 1][1] : 'Main';
};

const LANGUAGES = {
  py: {
    prepare: async (dir, code) => ({ file: await writeSource(dir, 'main.py', code) }),
    compile: null,
    run: (dir, { file }) => ({ command: cfg.pythonBin, args: ['-I', '-B', file] }),
  },
  cpp: {
    prepare: async (dir, code) => ({
      file: await writeSource(dir, 'main.cpp', code),
      exe: path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main'),
    }),
    compile: (dir, { file, exe }) => ({
      command: 'g++',
      args: ['-std=c++17', '-O2', '-pipe', file, '-o', exe],
      memoryMb: 1024,
    }),
    run: (dir, { exe }) => ({ command: exe, args: [] }),
  },
  java: {
    prepare: async (dir, code) => {
      const className = javaMainClass(code);
      return { className, file: await writeSource(dir, `${className}.java`, code) };
    },
    compile: (dir, { file }) => ({
      command: 'javac',
      args: ['-J-Xmx512m', '-J-XX:+UseSerialGC', '-encoding', 'UTF-8', '-d', dir, file],
      limitAddressSpace: false,
    }),
    run: (dir, { className }) => ({
      command: 'java',
      args: [
        `-Xmx${cfg.memoryLimitMb}m`,
        '-Xss64m',
        '-XX:+UseSerialGC',
        '-XX:TieredStopAtLevel=1',
        '-XX:MaxMetaspaceSize=128m',
        '-cp',
        dir,
        className,
      ],
      limitAddressSpace: false,
    }),
  },
};

const SIGNAL_MESSAGES = {
  SIGSEGV: 'Segmentation fault (invalid memory access)',
  SIGFPE: 'Floating point exception (e.g. division by zero)',
  SIGABRT: 'Program aborted',
  SIGXCPU: 'CPU time limit exceeded',
  SIGXFSZ: 'File size limit exceeded',
};

const describeRun = (result, dir) => {
  if (result.spawnError) return { success: false, error: `Failed to start program: ${result.spawnError}` };
  if (result.timedOut) {
    return { success: false, error: `Time Limit Exceeded (${cfg.runTimeoutMs / 1000}s). Check for infinite loops.`, timedOut: true };
  }
  if (result.outputLimitExceeded) {
    return { success: false, error: 'Output Limit Exceeded (too much output).', output: result.stdout };
  }
  if (result.signal || result.exitCode !== 0) {
    const reason =
      SIGNAL_MESSAGES[result.signal] || (result.signal ? `Killed by ${result.signal}` : `Process exited with code ${result.exitCode}`);
    const stderr = scrubPaths(result.stderr, dir).trim();
    return { success: false, error: stderr ? `${stderr}\n\n${reason}` : reason, output: result.stdout };
  }
  return { success: true, output: result.stdout, durationMs: Math.round(result.durationMs) };
};

/**
 * Compiles once (if needed) and runs the program against each input.
 * Returns one result per input: { success, output?, error?, durationMs? }.
 * Throws ExecutionError for validation and compile errors.
 */
const executeTests = async (language, code, inputs) => {
  const lang = LANGUAGES[normalizeLanguage(language)];
  if (typeof code !== 'string' || !code.trim()) throw new ExecutionError('Code is required.', 'validation');

  await slots.acquire();
  let dir;
  try {
    dir = await createJobDir();
    const ctx = await lang.prepare(dir, code);

    if (lang.compile) {
      const spec = lang.compile(dir, ctx);
      const result = await runProcess({ ...spec, cwd: dir, timeoutMs: cfg.compileTimeoutMs });
      if (result.spawnError) {
        throw new ExecutionError(`Compiler unavailable: ${result.spawnError}`, 'compile', 500);
      }
      if (result.timedOut) throw new ExecutionError('Compilation timed out.', 'compile', 422);
      if (result.exitCode !== 0) {
        const message = scrubPaths(result.stderr || result.stdout, dir).trim() || 'Compilation failed.';
        throw new ExecutionError(message, 'compile', 422);
      }
    }

    const results = [];
    for (const input of inputs) {
      const spec = lang.run(dir, ctx);
      const result = await runProcess({ ...spec, cwd: dir, input: String(input ?? ''), timeoutMs: cfg.runTimeoutMs });
      results.push(describeRun(result, dir));
    }
    return results;
  } finally {
    if (dir) await removeJobDir(dir);
    slots.release();
  }
};

/** Runs a single program; resolves to stdout or throws ExecutionError. */
const executeCode = async (language, code, input = '') => {
  const [result] = await executeTests(language, code, [input]);
  if (!result.success) throw new ExecutionError(result.error, 'runtime', 422);
  return result.output;
};

module.exports = {
  ExecutionError,
  executeCode,
  executeTests,
  normalizeLanguage,
  javaMainClass,
  sandboxMode,
  assertSandboxReady,
};
