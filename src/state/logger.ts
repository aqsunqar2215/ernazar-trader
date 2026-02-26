type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(private readonly scope: string = 'app') {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: Level, message: string, meta?: Record<string, unknown>): void {
    const line = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...meta,
    };
    const payload = JSON.stringify(line);
    if (level === 'error') {
      console.error(payload);
      return;
    }
    console.log(payload);
  }
}
