import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentDefinition, DecisionResponse, Observation, Side } from './contracts.js';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

class LineQueue {
  private readonly lines: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private error: Error | null = null;

  push(line: string) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.lines.push(line);
  }

  fail(error: Error) {
    this.error = error;
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  take(timeoutMs: number): Promise<string> {
    if (this.error) return Promise.reject(this.error);
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    return new Promise((resolveLine, reject) => {
      let done = false;
      const waiter = { resolve: (_line: string) => {}, reject, timer: undefined as unknown as NodeJS.Timeout };
      waiter.resolve = line => {
        if (done) return;
        done = true;
        clearTimeout(waiter.timer);
        resolveLine(line);
      };
      waiter.timer = setTimeout(() => {
        done = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`agent response timeout after ${timeoutMs}ms`));
      }, Math.max(1, timeoutMs));
      this.waiters.push(waiter);
    });
  }
}

export class AgentProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout = new LineQueue();
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBytes = 0;
  private stdoutBuffer = '';
  private stderrText = '';
  private exited = false;

  private constructor(
    private readonly definition: AgentDefinition,
    readonly side: Side,
    private readonly onDiagnostic: (message: string) => void,
  ) {
    this.child = spawn(definition.command, definition.args, {
      cwd: resolve(definition.cwd),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', chunk => this.readStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.child.stderr.on('data', chunk => {
      if (this.stderrText.length < MAX_STDERR_BYTES) {
        this.stderrText += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - this.stderrText.length);
      }
    });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      const detail = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
      this.fail(new Error(`agent ${side} ${detail}${this.stderrText ? `: ${this.stderrText.trim()}` : ''}`));
    });
  }

  static start(definition: AgentDefinition, side: Side, onDiagnostic: (message: string) => void) {
    return new AgentProcess(definition, side, onDiagnostic);
  }

  private fail(error: Error) {
    if (!this.exited) this.onDiagnostic(error.message);
    this.stdout.fail(error);
  }

  private readStdout(chunk: Buffer) {
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.fail(new Error('agent stdout exceeded limit'));
      this.kill();
      return;
    }
    this.stdoutBuffer += this.decoder.write(chunk);
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && !this.stdoutBuffer.includes('\n')) {
      this.fail(new Error('agent protocol line exceeded limit'));
      this.kill();
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.fail(new Error('agent protocol line exceeded limit'));
        this.kill();
        return;
      }
      this.stdout.push(line);
    }
  }

  private write(value: unknown) {
    if (this.exited || !this.child.stdin.writable) throw new Error('agent process is not writable');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async initialize(matchId: string, policySeed: number, config: Record<string, unknown>, timeoutMs: number) {
    this.write({ type: 'init', protocolVersion: 1, matchId, side: this.side, policySeed, config });
    const line = await this.stdout.take(timeoutMs);
    let message: unknown;
    try { message = JSON.parse(line); } catch { throw new Error('agent ready response was not JSON'); }
    if (!isRecord(message) || message.type !== 'ready' || message.protocolVersion !== 1) {
      throw new Error('agent did not send a valid ready response');
    }
  }

  async decide(observation: Observation, timeoutMs: number): Promise<DecisionResponse> {
    this.write(observation);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`agent response timeout after ${timeoutMs}ms`);
      const line = await this.stdout.take(remaining);
      let message: unknown;
      try { message = JSON.parse(line); } catch { throw new Error('agent decision response was not JSON'); }
      if (!isRecord(message) || typeof message.requestId !== 'number' || !isRecord(message.action)) {
        throw new Error('agent decision response has invalid shape');
      }
      if (message.requestId !== observation.requestId) {
        this.onDiagnostic(`discarded stale agent response requestId=${String(message.requestId)} expected=${observation.requestId}`);
        continue;
      }
      return message as unknown as DecisionResponse;
    }
  }

  end(winner: Side | null, reason: string) {
    if (this.exited) return;
    try { this.write({ type: 'end', winner, reason }); } catch { /* process is already gone */ }
  }

  kill() {
    if (this.exited) return;
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
    } catch { this.child.kill('SIGKILL'); }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
