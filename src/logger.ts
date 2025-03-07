import {
  createLogger, format, transports, Logger,
} from 'winston';
import chalk from 'chalk';
import moment from 'moment-timezone';
import config from '../config.json' with { type: 'json' };

export default new class LoggerInstance {
  readonly #winston: Logger;

  constructor() {
    this.#winston = createLogger({
      levels: { error: 0, warn: 1, debug: 2 },
      level: 'debug',
      format: format.combine(
        format.timestamp({
          format: () => moment().tz(config.timezone ?? 'America/Anchorage').format('MM/DD/YYYY HH:mm:ss.SSSSSS'),
        }),
        format.printf(({ level, message, timestamp }) => {
          switch (level) {
            case 'error':
              return `STR ${timestamp} ${chalk.bgRedBright.bold(' ERROR ')} ${chalk.red(message)}`;
            case 'warn':
              return `STR ${timestamp} ${chalk.bgYellow.bold(' WARN ')} ${chalk.yellow(message)}`;
            case 'debug':
              return `STR ${timestamp} ${chalk.bgCyan.bold(' DEBUG ')} ${chalk.cyan(message)}`;
            default:
              return `STR ${timestamp} ${chalk.bgWhite.bold(' LOG ')} ${chalk.white(message)}`;
          }
        }),
      ),
      transports: [new transports.Console()],
    });
  }

  public error(...args: string[]): void {
    this.#winston.log('error', this.toString(args));
  }

  public debug(...args: string[]): void {
    this.#winston.log('debug', this.toString(args));
  }

  public warn(...args: string[]): void {
    this.#winston.log('warn', this.toString(args));
  }

  public toString(args: string[]): string {
    return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  }
}();
