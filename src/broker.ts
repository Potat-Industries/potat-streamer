/* eslint-disable no-unused-vars */ // fucking hate eslint SO MANY PLUGINS REQUIRED
import Logger from './logger.js';
import { Page } from 'puppeteer';
import { RestartScope, streamer } from './index.js';
import {
  connect,
  JSONCodec,
  Msg,
  NatsConnection,
} from 'nats';

export enum EventStream {
  // Consumers
  API = 'potat-api.>',
  BOT = 'potatbotat.>',
  STREAMER = 'potat-streamer.>',

  // API Topics
  API_PING = 'potat-api.ping',
  API_PONG = 'potat-api.pong',
  API_CONNECTED = 'potat-api.connected',
  API_POSTGRES_BACKUP = 'potat-api.postgres-backup',
  API_JOB_REQUEST = 'potat-api.job-request',

  // Streamer Topics
  STREAMER_PING = 'potat-streamer.ping',
  STREAMER_PONG = 'potat-streamer.pong',
  STREAMER_CONNECTED = 'potat-streamer.connected',

  // Bot Topics
  PROXY_SOCKET = 'potatbotat.proxy-socket',
  PING = 'potatbotat.ping',
  PONG = 'potatbotat.pong',
  STREAMER_EVAL = 'potatbotat.streamer-eval',
  STREAMER_RESTART = 'potatbotat.streamer-restart',
  STREAMER_RELOAD = 'potatbotat.streamer-reload',
}

export class NatsClient {
  #client?: NatsConnection;

  #jsoncodec = JSONCodec;

  #retryCount = 0;

  #destroyed = false;

  public page: Page | undefined;

  set setPage(page: Page | undefined) {
    this.page = page;
  }

  readonly jobs: Map<string, any> = new Map();

  public get client(): NatsConnection {
    if (!this.#client) {
      throw new Error('NATS client not initialized');
    }

    return this.#client;
  }

  public async initialize(): Promise<void> {
    try {
      const client = await connect({ servers: 'localhost' });
      this.#client = client;

      const done = client.closed();

      this.#retryCount = 0;

      this.setConsumer(EventStream.BOT);

      // The bot being offline is not a broker failure, so stay connected.
      try {
        await client.request(EventStream.STREAMER_PING, undefined, { timeout: 5000 });
        Logger.debug('Broker connected');
        this.publish(EventStream.STREAMER_CONNECTED);
      } catch (err) {
        Logger.warn(`Failed to ping PotatBotat: ${(err as Error).message}`);
      }

      // blocking until the connection is closed
      const err = await done;
      if (err) {
        Logger.error(`NATS connection closed: ${err.message}`);
      }

      if (!this.#destroyed) {
        Logger.warn('NATS connection unexpectedly closed, reconnecting...');
        return this.reconnect();
      }

      Logger.warn(`NATS connection closed`);
    } catch (err) {
      Logger.error(`Failed to connect to NATS: ${(err as Error).message}`);
      this.reconnect();
    }
  }

  public async destroy(): Promise<void> {
    this.#destroyed = true;

    if (this.#client) {
      Logger.warn('Closing NATS connection');
      await this.#client.drain();
    }

    this.#client = undefined;
  }

  public async reconnect(): Promise<void> {
    if (this.#destroyed) {
      return;
    }

    const previous = this.#client;
    this.#client = undefined;

    await previous?.close().catch((err) => {
      Logger.warn(`Failed to close NATS connection: ${(err as Error).message}`);
    });

    this.#retryCount++;
    const delay = Math.min(1000 * 2 ** this.#retryCount, 30000); // Exponential backoff
    await new Promise((resolve) => setTimeout(resolve, delay));

    return this.initialize();
  }

  public async setConsumer(subject: string): Promise<void> {
    for await (const message of this.client.subscribe(subject)) {
      this.handleMessage(message);
    }
  }

  public async publish(subject: string, data?: any): Promise<string> {
    const id = `${subject}.${crypto.randomUUID()}`;
    try {
      this.client.publish(subject, this.#jsoncodec<typeof data>().encode(data), {
        reply: id,
      });
    } catch (err) {
      Logger.error(`Failed to publish message to NATS: ${(err as Error).message}`);
    }

    return id;
  }

  public parseMessage<T = any>(data: Uint8Array): T {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      message = data.toString();
    }

    return message as T;
  }

  public async handleMessage(message: Msg): Promise<void> {
    const data = this.parseMessage(message.data);

    switch (message.subject) {
      case EventStream.PING: {
        message.respond(this.#jsoncodec().encode({ pong: true }));
        break;
      }
      case EventStream.PONG: {
        Logger.debug('Broker connected');

        break;
      }
      case EventStream.STREAMER_RELOAD: {
        if (!message.reply) {
          Logger.error('No reply subject provided for job request');

          return;
        }

        if (this.page) {
          Logger.debug('Reloading page');
          const result = await this.page.reload().catch((err) => {
            Logger.warn(`Page reload failed: ${(err as Error).message}`);
          });
          await this.publish(message.reply, Boolean(result));
        } else {
          Logger.warn('Page is not defined, cannot reload');
          await this.publish(message.reply, false);
        }

        break;
      }
      case EventStream.STREAMER_RESTART: {
        if (!message.reply) {
          Logger.error('No reply subject provided for job request');

          return;
        }

        const scope: RestartScope = data?.target === 'page' || data?.target === 'ffmpeg' ? data.target : 'all';

        Logger.debug(`Restarting stream (${scope})`);
        const result = await streamer.restartStream(scope);
        await this.publish(message.reply, result);

        break;
      }
      case EventStream.STREAMER_EVAL: {
        if (!message.reply) {
          Logger.error('No reply subject provided for job request');

          return;
        }

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

          Logger.debug(`Evaluating script: ${code}`);

          try {
            const result = await this.page.evaluate(code);
            code = typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
          } catch (err) {
            code = (err as Error).message;
          }

          await this.publish(message.reply, { id: jobId, result: code });

          Logger.debug(`Script evaluated: ${code}`);
        } else {
          Logger.warn('Page is not defined, cannot evaluate script');
          await this.publish(message.reply, { id: data?.id, result: 'Page is not available' });
        }

        break;
      }
      case EventStream.PROXY_SOCKET: {
        break;
      }
      default: {
        Logger.warn(`Unknown message subject: ${message.subject}`);
      }
    }
  }
}
