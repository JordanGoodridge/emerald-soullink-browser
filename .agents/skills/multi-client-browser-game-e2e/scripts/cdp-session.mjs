// Dependency-free Chrome DevTools Protocol helpers for multi-client browser E2E.
//
// This is a template, not a framework. Copy it into the test harness and adapt
// selectors, readiness predicates and launch flags to the application.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_BROWSER_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function findBrowser() {
  const found = DEFAULT_BROWSER_CANDIDATES.filter(Boolean).find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found; set CHROME_BIN');
  return found;
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

function waitForLine(child, pattern, timeoutMs, label) {
  return withTimeout(new Promise((resolveLine, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(pattern);
      if (!match) return;
      child.stderr.off('data', onData);
      resolveLine(match);
    };
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`${label} exited before ready with ${code}`)));
  }), timeoutMs, `starting ${label}`);
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolveStop) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', resolveStop);
      killer.on('error', resolveStop);
    });
    return;
  }
  child.kill('SIGTERM');
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolveStop();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

export async function launchBrowser({
  browserPath = findBrowser(),
  headed = false,
  userDataDir = null,
  extraArgs = [],
  timeoutMs = 20000,
} = {}) {
  const profile = userDataDir ?? await mkdtemp(join(tmpdir(), 'browser-e2e-'));
  const ownsProfile = userDataDir === null;
  const args = [
    headed ? '--headless=old' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-unsafe-webgpu',
    '--window-size=960,720',
    ...extraArgs,
    'about:blank',
  ].filter((arg) => arg !== '--headless=old');

  const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  try {
    const match = await waitForLine(child, /DevTools listening on (ws:\/\/[^\s]+)/, timeoutMs, 'headless Chrome');
    return {
      child,
      browserWs: match[1],
      userDataDir: profile,
      logs,
      async close() {
        await stopProcess(child);
        if (ownsProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await stopProcess(child);
    if (ownsProfile) await rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.addEventListener('open', resolveReady, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler) handler(message.params);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready;
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return await withTimeout(new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    }), timeoutMs, method);
  }

  close() {
    this.socket.close();
  }
}

export async function newPage(browserWs) {
  const endpoint = new URL(browserWs);
  const response = await fetch(`http://${endpoint.host}/json/new`, { method: 'PUT' });
  if (!response.ok) throw new Error(`could not create browser target: ${response.status}`);
  const target = await response.json();
  return new Cdp(target.webSocketDebuggerUrl);
}

export function installDiagnostics(cdp, { onConsole = null, onException = null } = {}) {
  if (onConsole) {
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (text) onConsole(text, params.type);
    });
  }
  if (onException) {
    cdp.on('Runtime.exceptionThrown', (params) => {
      const text = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
      if (text) onException(text, params.exceptionDetails);
    });
  }
  return cdp.send('Runtime.enable');
}

export async function navigate(cdp, url) {
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
}

export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const exception = details.exception?.description || details.exception?.value;
    const location = `${details.url || '<anonymous>'}:${details.lineNumber ?? 0}:${details.columnNumber ?? 0}`;
    throw new Error([details.text, exception, location].filter(Boolean).join('\n'));
  }
  return result.result.value;
}

export async function waitFor(cdp, expression, label, timeoutMs = 20000, intervalMs = 100) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function captureScreenshot(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(file, Buffer.from(result.data, 'base64'));
  return file;
}
