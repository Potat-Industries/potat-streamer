/* eslint-disable no-undef */
import puppeteer, {
  Browser,
  CDPSession,
  CookieData,
  LaunchOptions,
} from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import Logger from './logger.js';
import configuration from '../config.json' with { type: 'json' };
import { NatsClient } from './broker.js';
import { readFile } from 'fs/promises';
import kill from 'tree-kill';

const startupImage = await readFile('image.png').catch(() => {
  Logger.error('Could not read startup image');
});

class Streamer {
  private cookieLoop: NodeJS.Timeout | undefined;

  private browserSession: Browser | undefined;

  private restarting = false;

  private restartLoop: NodeJS.Timeout | undefined;

  private restartCount = 0;

  private clientListener: CDPSession | undefined;

  private pid: number | undefined;

  private config: typeof configuration;

  private cleanupFFmpeg: () => void = () => {};

  private readonly currentFrame = { frame: startupImage ?? Buffer.alloc(0) };

  private readonly broker = new NatsClient();

  constructor(config: typeof configuration) {
    this.config = config;
    if (!this.config.streamKey || !this.config.url) {
      Logger.error('Please provide streamKey and url in this.config.json');
      process.exit(1);
    }

    process.on('SIGINT', () => this.shutdownHook());
    process.on('SIGTERM', () => this.shutdownHook());
    process.on('exit', () => this.shutdownHook());
    process.on('uncaughtException', (err) => {
      Logger.error('Uncaught Exception:', (err as Error).stack ?? err.toString());
      ++this.restartCount;
      this.restartStream();
    });
    process.on('unhandledRejection', (err) => {
      Logger.error('Unhandled Rejection:', (err as Error).stack ?? JSON.stringify(err));
    });

    this.initStream().then(() => this.broker.initialize());
  }

  public async restartStream(): Promise<boolean> {
    if (this.restartCount >= 5) {
      Logger.error('Restart limit reached. Exiting...');
      this.shutdownHook();
    }
    if (this.restarting) {
      return false;
    }

    this.restarting = true;
    try {
      Logger.debug('Restarting stream...');
      await this.closeFFmpeg();
      this.broker.setPage = undefined;
      await this.initStream();
      Logger.debug('Stream restarted');

      return true;
    } catch (e) {
      Logger.error('Failed to restart stream:', (e as Error).message);

      return false;
    } finally {
      this.restarting = false;
      this.restartCount = 0;
    }
  }

  private async closeFFmpeg(): Promise<boolean> {
    return new Promise((resolve) => {
      this.cleanupFFmpeg();
      if (this.pid) {
        Logger.warn(`Killing FFmpeg process with PID: ${this.pid}`);

        // Use tree-kill to ensure all child processes are killed.
        kill(this.pid, 'SIGKILL', (err) => {
          if (err) {
            Logger.error('Failed to kill FFmpeg process: ', (err as Error).message);
          } else {
            Logger.debug('FFmpeg process killed');
          }
        });
      } else {
        Logger.error('No FFmpeg process found to kill!');
      }

      this.pid = undefined;
      this.cleanupFFmpeg = () => {};

      resolve(true);
    });
  }

  private async shutdownHook(): Promise<void> {
    Logger.debug('Killing FFmpeg process...');
    await this.closeFFmpeg();
    await this.browserSession?.close();
    await this.broker.destroy();
    Logger.debug('Exiting...');
    process.exit();
  }

  private async spawnFFmpeg(): Promise<ChildProcessWithoutNullStreams> {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-re',
      '-stream_loop', '-1',
      '-f', 'image2pipe',
      '-r', '30',
      '-i', '-',
      '-i', 'music.mp3',
      '-filter_complex', '[1:a]aloop=loop=-1:size=2e9[aout]',
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-b:v', '5000k',
      '-maxrate', '6000k',
      '-bufsize', '12000k',
      '-g', '60',
      '-keyint_min', '60',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'flv',
      `rtmp://127.0.0.1:1935/live/potato`,
    ]);

    this.pid = ffmpeg.pid;

    this.cleanupFFmpeg = async (): Promise<void> => {
      try {
        Logger.warn('Cleaning up FFmpeg...');
        ffmpeg.stdin.end();
        ffmpeg.stdout.destroy();
        ffmpeg.stderr.destroy();
        clearInterval(this.cookieLoop);
        if (this.clientListener) {
          this.clientListener.removeAllListeners();
        }
      } catch (err) {
        Logger.error('Error cleaning up FFmpeg:', (err as Error).message);
      }
    };

    Logger.debug('Spawned FFmpeg');

    ffmpeg.stderr.on('data', (data) => {
      Logger.debug('FFmpeg: '.concat(data.toString()));
    });

    ffmpeg.on('error', (err) => {
      Logger.error('FFmpeg error:', (err as Error).message);
    });

    if (this.restartLoop) {
      clearInterval(this.restartLoop);
    }

    this.restartLoop = setInterval(() => {
      this.restartStream().catch((err) => {
        Logger.error('Error during restart loop:', (err as Error).message);
      });
    }, 48 * 60 * 60 * 1000); // Restart every 2 days.

    return ffmpeg;
  }

  private async startStreaming(ffmpeg: ChildProcessWithoutNullStreams): Promise<void> {
    while (true) {
      if (!ffmpeg.stdin.writable) {
        break;
      }

      try {
        if (this.currentFrame.frame) {
          ffmpeg.stdin.write(this.currentFrame.frame);
        }
      } catch (err) {
        Logger.error('Error writing to FFmpeg stdin:', (err as Error).message);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserSession) {
      await this.browserSession.close();
    }

    const browserConfig: LaunchOptions = {
      headless: true,
      args: ['--window-size=1920,1080', '--no-sandbox'],
    };

    if (this.config.executablePath) {
      browserConfig.executablePath = this.config.executablePath;
    }

    return puppeteer.launch(browserConfig);
  }

  private updateCookies(browser: Browser, cookies: CookieData[]): NodeJS.Timeout {
    return setInterval(async () => {
      const newCookies = await browser.cookies();
      if (JSON.stringify(cookies) !== JSON.stringify(newCookies)) {
        writeFileSync('cookies.json', JSON.stringify(newCookies));
        cookies = newCookies;
      }
    }, 10000);
  }

  private async getClient(browser: Browser): Promise<CDPSession> {
    const page = await browser.newPage();

    this.broker.setPage = page;

    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(this.config.url, { waitUntil: 'networkidle0' });

    if (this.config.grafanaEnabled) {
      if (page.url() !== this.config.url) {
        Logger.warn('Cookies expired... signing into Grafana');
        await this.signIntoGrafana();
        await page.goto(this.config.url, { waitUntil: 'networkidle0' });
        if (page.url() !== this.config.url) {
          throw new Error('Failed to sign into Grafana');
        }
      }

      page.on('requestfailed', async (request) => {
        if (request.response()?.status() === 403) {
          Logger.warn('Cookies have expired... signing into Grafana');
          await this.signIntoGrafana();
          await page.goto(this.config.url, { waitUntil: 'networkidle0' });
          if (page.url() !== this.config.url) {
            throw new Error('Failed to re-sign into Grafana');
          }
        }
      });
    }

    if (this.config.injectedCss.length) {
      Logger.debug('Injecting CSS');
      try {
        await page.click('#dock-menu-button');
      } catch {
        Logger.warn('Dock menu button not found, skipping click for CSS injection');
      }
      await page.addStyleTag({ content: this.config.injectedCss });
    }

    setInterval(() => page.reload(), 10 * 60 * 60 * 1000);

    return page.createCDPSession();
  }

  private async signIntoGrafana(): Promise<void> {
    if (!this.browserSession) {
      throw new Error('Browser session not initialized');
    }

    const page = await this.browserSession.newPage();
    await page.goto(this.config.url, { waitUntil: 'networkidle0' });

    await page.type('[data-testid="data-testid Username input field"]', this.config.grafanaUser);
    await page.type('[data-testid="data-testid Password input field"]', this.config.grafanaPass);

    Logger.debug('Logging in...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click('[data-testid="data-testid Login button"]'),
    ]);

    Logger.debug('Logged in, updating cookies...');
    const cookies = await this.browserSession.cookies();
    writeFileSync('cookies.json', JSON.stringify(cookies));

    if (this.cookieLoop) {
      clearInterval(this.cookieLoop);
    }

    this.cookieLoop = this.updateCookies(this.browserSession, cookies);

    await page.close();
    Logger.warn('Signed into Grafana!');
  }

  private async initStream(): Promise<void> {
    const ffmpeg = await this.spawnFFmpeg();

    this.startStreaming(ffmpeg);

    this.browserSession = await this.getBrowser();
    Logger.debug('Created browser');

    const cookies = JSON.parse(readFileSync('cookies.json', 'utf8'));
    await this.browserSession.setCookie(...cookies);

    this.cookieLoop = this.updateCookies(this.browserSession, cookies);

    const client = await this.getClient(this.browserSession);
    Logger.debug('Created page and client');

    await client.send('Page.enable');
    await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    this.clientListener = client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      this.currentFrame.frame = Buffer.from(data, 'base64');
      await client.send('Page.screencastFrameAck', { sessionId });
    });

    Logger.debug('Started screencast');
  }
}

export const streamer = new Streamer(configuration);
