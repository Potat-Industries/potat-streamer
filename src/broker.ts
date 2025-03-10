import ampqlib from 'amqplib';
import Logger from './logger.js';
import config from '../config.json' with { type: 'json' };
import { Page } from 'puppeteer';
import { streamer } from './index.js';

export class Broker {
  private connection?: ampqlib.Connection;

  private channel?: ampqlib.Channel;

  readonly #options: ampqlib.Options.Connect;

  public page: Page | undefined;

  #retryCount = 0;

  constructor() {
    this.#options = {
      hostname: config.rabbitmq?.host,
      port: config.rabbitmq?.port,
      username: config.rabbitmq?.username,
      password: config.rabbitmq?.password,
    };
  }

  set setPage(page: Page | undefined) {
    this.page = page;
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await ampqlib.connect(this.#options);
      this.channel = await this.connection.createChannel();

      this.connection?.on('close', async () => {
        Logger.warn('Broker connection closed');
        this.connection = undefined;
        this.channel = undefined;
        return this.reconnect();
      });

      await this.setQueues();
      this.#retryCount = 0;

      this.ping();
    } catch (e) {
      Logger.error(`Failed to connect to broker: ${(e as Error).message}`);
      return this.reconnect();
    }
  }

  public async destroy(): Promise<void> {
    if (this.connection) {
      Logger.warn('Closing broker connection');
      await this.channel?.close();
      await this.connection.close();
    }

    this.connection = undefined;
    this.channel = undefined;
  }

  public async reconnect(): Promise<void> {
    await this.destroy();

    this.#retryCount++;
    const delay = Math.min(1000 * 2 ** this.#retryCount, 30000); // Exponential backoff
    await new Promise((resolve) => setTimeout(resolve, delay));
    return this.connect();
  }

  public async setQueues(): Promise<void> {
    if (!this.channel) {
      Logger.error('Failed to create channel');
      return this.reconnect();
    }

    const queue = await this.channel.assertQueue('potat-api', { durable: true });

    await this.channel.assertExchange('potat-streamer', 'direct', { durable: true });
    await this.channel.bindQueue(queue.queue, 'potat-streamer', 'potat-api');
    await this.channel.consume(queue.queue, this.handleMessage.bind(this), {
      noAck: false,
      noLocal: true,
    });

    await this.publish('potat-api', 'ping');
  }

  public ping(): void {
    if (!this.connection) {
      Logger.error('Failed to ping broker: no connection');
      return;
    }

    Logger.debug('Pinging broker...');
    this.publish('potat-streamer', 'ping');
  }

  public async publish(
    queue: string,
    message: string,
    options: ampqlib.Options.Publish = {},
  ): Promise<void> {
    if (!this.connection || !this.channel) {
      return;
    }

    const ok = this.channel.sendToQueue(queue, Buffer.from(message), {
      expiration: 5000,
      /** scuffed way to ignore local queue consumption @todo dedicated 1 way exchanges */
      correlationId: 'potat-streamer',
      ...options,
    });

    if (!ok) {
      Logger.error(`Failed to publish message to exchange ${queue}: ${message}`);
    }
  }

  private parseMessage(message: string): [string, any] {
    try {
      const [topic, ...rest] = message.split(':');
      const data = rest.length ? JSON.parse(rest.join(':')) : null;
      return [topic, data];
    } catch (error) {
      Logger.error(`Failed to parse message: ${message}`, (error as Error).toString());
      return ['', null];
    }
  }

  private async handleMessage(msg: ampqlib.ConsumeMessage | null): Promise<void> {
    if (!msg) return;

    try {
      const message = msg.content.toString();

      // Ignore locally sent messages, requeue for intended consumer
      // TODO: add single directional queue/exchanges to skip the extra handling?
      if (msg.properties.correlationId === 'potat-streamer') {
        this.channel?.reject(msg, true);
        return;
      }

      this.channel?.ack(msg);

      const [topic, data] = this.parseMessage(message);
      if (!topic) return;

      switch (topic) {
        case 'ping':
          await this.publish('potat-streamer', 'pong');
          break;
        case 'pong':
          Logger.debug('Broker pong');
          break;
        case 'connected':
          Logger.debug('Broker reconnected');
          break;
        case 'restart': {
          Logger.debug(`Restarting stream`);
          const result = await streamer.restartStream();
          await this.publish('potat-streamer', `streamer-restart:${JSON.stringify(result)}`);
          break;
        }
        case 'reload': {
          if (this.page) {
            Logger.debug('Reloading page');
            const result = await this.page.reload();
            if (result) {
              await this.publish('potat-streamer', `streamer-reload:${JSON.stringify(true)}`);
            } else {
              await this.publish('potat-streamer', `streamer-reload:${JSON.stringify(false)}`);
              Logger.warn('Page reload failed');
            }
          } else {
            Logger.warn('Page is not defined, cannot reload');
          }
          break;
        }
        case 'eval': {
          if (this.page) {
            const jobId = data?.id;
            let code = data?.code;
            if (!jobId || !code) {
              Logger.warn('Invalid eval data');
              return;
            }

            if (/return|await/.test(code)) {
              code = `(async () => { ${code} } )()`;
            }

            const toString = async (something: any): Promise<string> => {
              if (something instanceof Error) {
                return something.constructor.name + ': ' + something.message;
              }
              if (something instanceof Promise) {
                return something.then(toString);
              }
              if (Array.isArray(something)) {
                return something.map((item: any) => toString(item)).join(', ');
              }
              if (typeof something === 'function' || typeof something === 'symbol') {
                return something.toString();
              }
              return JSON.stringify(something);
            };

            Logger.debug(`Evaluating script: ${code}`);
            const result = await Promise
              .resolve(eval(code))
              .then(toString);

            await this.publish(
              'potat-streamer',
              `streamer-eval:${JSON.stringify({ id: jobId, result })}`,
            );

            Logger.debug(`Script evaluated: ${result}`);
          } else {
            Logger.warn('Page is not defined, cannot evaluate script');
          }
          break;
        }
        default:
          Logger.warn(`Unhandled message topic: ${topic}`);
      }
    } catch (error) {
      Logger.error(`Error handling message: ${(error as Error).message}`);
    }
  }
}
