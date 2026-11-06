/* eslint-disable no-undef */
import puppeteer, {
  Browser,
  CDPSession,
  CookieData,
  LaunchOptions,
  Page,
} from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import Logger from './logger.js';
import configuration from '../config.json' with { type: 'json' };
import { NatsClient } from './broker.js';
import kill from 'tree-kill';

// FFmpeg's pipe input decodes a single codec, so this has to match the screencast format.
const loadStartupFrame = (): Buffer => {
  const { status, stdout } = spawnSync('ffmpeg', [
    '-loglevel', 'error',
    '-i', 'image.png',
    '-frames:v', '1',
    '-c:v', 'mjpeg',
    '-q:v', '2',
    '-f', 'image2pipe',
    'pipe:1',
  ], { maxBuffer: 32 * 1024 * 1024 });

  if (status !== 0 || !stdout?.length) {
    Logger.error('Could not read startup image');

    return Buffer.alloc(0);
  }

  return stdout;
};

const PAGE_SETTLE_TIMEOUT_MS = 10_000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 30_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const FFMPEG_EXIT_TIMEOUT_MS = 2_000;
const FFMPEG_STABLE_UPTIME_MS = 30_000;
const MAX_RESTART_DELAY_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_FAILURE_THRESHOLD = 2;
const PAGE_RELOAD_INTERVAL_MS = 10 * 60 * 60 * 1000;
const GRAFANA_SIGN_IN_COOLDOWN_MS = 5 * 60 * 1000;

export type RestartScope = 'all' | 'page' | 'ffmpeg';

interface StreamerConfig {
  url: string;
  grafanaUser: string;
  grafanaPass: string;
  grafanaEnabled: boolean;
  injectedCss: string;
  executablePath?: string;
  timezone: string;
  readySelector?: string;
  liveCheckAPIEnabled?: boolean;
  liveCheckUrl?: string;
  liveCheckIntervalMs?: number;
  liveCheckFalseThreshold?: number;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const restartDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, MAX_RESTART_DELAY_MS);

// Runs in the page before any of its own scripts, on every navigation. The document
// has no root element yet at that point, so the first attempts can be no-ops.
const injectStyle = (css: string): void => {
  const add = (): void => {
    if (document.getElementById('potat-injected-css') || !document.documentElement) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'potat-injected-css';
    style.textContent = css;
    (document.head ?? document.documentElement).appendChild(style);
  };

  document.addEventListener('readystatechange', add);
  document.addEventListener('DOMContentLoaded', add);
  add();
};

class Streamer {
  private cookieLoop: NodeJS.Timeout | undefined;

  private browserSession: Browser | undefined;

  private page: Page | undefined;

  private reloadLoop: NodeJS.Timeout | undefined;

  private healthCheckFailures = 0;

  private signingIn = false;

  private lastSignInAt = 0;

  private shuttingDown = false;

  private restarting = false;

  private liveCheckLoop: NodeJS.Timeout | undefined;

  private liveCheckFalseCount = 0;

  private restartCount = 0;

  private restartTimer: NodeJS.Timeout | undefined;

  private pendingRestart: RestartScope | undefined;

  private ffmpegCrashCount = 0;

  private clientListener: CDPSession | undefined;

  private pid: number | undefined;

  private ffmpeg: ChildProcessWithoutNullStreams | undefined;

  private config: StreamerConfig;

  private cleanupFFmpeg: () => void = () => {};

  private readonly currentFrame = { frame: loadStartupFrame() };

  private readonly broker = new NatsClient();

  private readonly liveCheckInterval: number;

  private readonly liveCheckUrl: string;

  private readonly liveCheckAPIEnabled: boolean;

  private readonly liveCheckFalseThreshold: number;

  constructor(config: StreamerConfig) {
    this.config = config;
    this.liveCheckInterval = this.config.liveCheckIntervalMs ?? 5 * 60 * 1000;
    this.liveCheckUrl = this.config.liveCheckUrl || 'https://api.catquery.com/user/live?name=potatbotat';
    this.liveCheckAPIEnabled = this.config.liveCheckAPIEnabled ?? true;
    this.liveCheckFalseThreshold = this.config.liveCheckFalseThreshold ?? 3;

    if (!this.config.url) {
      Logger.error('Please provide url in config.json');
      process.exit(1);
    }

    process.on('SIGINT', () => this.shutdownHook());
    process.on('SIGTERM', () => this.shutdownHook());
    process.on('exit', () => this.shutdownHook());
    process.on('uncaughtException', (err) => {
      Logger.error('Uncaught Exception:', (err as Error).stack ?? err.toString());
      this.restartStream();
    });
    process.on('unhandledRejection', (err) => {
      Logger.error('Unhandled Rejection:', (err as Error).stack ?? JSON.stringify(err));
    });

    // Independent so remote commands still work if the first stream start fails.
    this.broker.initialize();
    this.startHealthCheck();
    this.restartStream();
  }

  public async restartStream(requested: RestartScope = 'all'): Promise<boolean> {
    if (this.restarting || this.shuttingDown) {
      return false;
    }

    const pending = this.pendingRestart;
    const scope = pending && pending !== requested ? 'all' : requested;
    const restartFFmpeg = scope !== 'page' || !this.ffmpeg;
    const restartPage = scope !== 'ffmpeg' || !this.browserSession;

    ++this.restartCount;

    // Page-only failures keep retrying: the stream is still up on its last frame.
    if (restartFFmpeg && this.restartCount >= 5) {
      Logger.error('Restart limit reached. Exiting...');
      await this.shutdownHook();

      return false;
    }

    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.pendingRestart = undefined;

    this.restarting = true;
    try {
      Logger.debug(`Restarting stream (ffmpeg: ${restartFFmpeg}, page: ${restartPage})...`);

      if (restartFFmpeg) {
        await this.closeFFmpeg();
        this.startFFmpeg();
      }

      if (restartPage) {
        await this.closePage();
        await this.startPage();
      }

      Logger.debug('Stream restarted');
      this.restartCount = 0;

      return true;
    } catch (e) {
      Logger.error('Failed to restart stream:', (e as Error).message);
      this.scheduleRestart(restartDelay(this.restartCount), this.ffmpeg ? 'page' : 'all');

      return false;
    } finally {
      this.restarting = false;
    }
  }

  private scheduleRestart(delayMs: number, scope: RestartScope): void {
    this.pendingRestart = this.pendingRestart && this.pendingRestart !== scope ? 'all' : scope;

    if (this.restartTimer) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;

      const pending = this.pendingRestart ?? 'all';
      if (this.restarting) {
        this.scheduleRestart(1000, pending);

        return;
      }

      this.restartStream(pending);
    }, delayMs);
  }

  private startHealthCheck(): void {
    setInterval(async () => {
      const { page } = this;
      if (!page || this.restarting || this.restartTimer) {
        return;
      }

      try {
        await withTimeout(page.evaluate('1'), HEALTH_CHECK_TIMEOUT_MS, 'Page health check');
        this.healthCheckFailures = 0;
      } catch (err) {
        // Stale result: the page was replaced while this check was in flight.
        if (page !== this.page) {
          return;
        }

        this.healthCheckFailures++;
        Logger.warn(`${(err as Error).message} (${this.healthCheckFailures}/${HEALTH_CHECK_FAILURE_THRESHOLD})`);

        if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
          this.healthCheckFailures = 0;
          this.scheduleRestart(0, 'page');
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browserSession;
    if (!browser) {
      return;
    }

    this.browserSession = undefined;

    try {
      await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'Browser close');
    } catch (err) {
      Logger.warn(`Force killing browser: ${(err as Error).message}`);
      browser.process()?.kill('SIGKILL');
    }
  }

  private async closePage(): Promise<void> {
    clearInterval(this.cookieLoop);
    clearInterval(this.reloadLoop);
    this.cookieLoop = undefined;
    this.reloadLoop = undefined;

    this.clientListener?.removeAllListeners();
    this.clientListener = undefined;

    this.page = undefined;
    this.broker.setPage = undefined;
    this.healthCheckFailures = 0;

    await this.closeBrowser();
  }

  private async closeFFmpeg(): Promise<void> {
    const { ffmpeg, pid } = this;

    this.cleanupFFmpeg();

    // Cleared first so the exit handler can tell this apart from a crash.
    this.pid = undefined;
    this.ffmpeg = undefined;
    this.cleanupFFmpeg = () => {};

    if (!ffmpeg || !pid) {
      Logger.debug('No FFmpeg process to kill');

      return;
    }

    Logger.warn(`Killing FFmpeg process with PID: ${pid}`);

    const exited = new Promise<void>((resolve) => {
      if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
        resolve();
      } else {
        ffmpeg.once('exit', () => resolve());
      }
    });

    // Use tree-kill to ensure all child processes are killed.
    kill(pid, 'SIGKILL', (err) => {
      if (err) {
        Logger.error('Failed to kill FFmpeg process: ', (err as Error).message);
      } else {
        Logger.debug('FFmpeg process killed');
      }
    });

    // nginx rejects a new publisher while the old one is still connected.
    await withTimeout(exited, FFMPEG_EXIT_TIMEOUT_MS, 'FFmpeg exit').catch((err) => {
      Logger.warn((err as Error).message);
    });
  }

  private async shutdownHook(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    Logger.debug('Killing FFmpeg process...');
    await this.closeFFmpeg();
    await this.closePage();
    await this.broker.destroy();
    Logger.debug('Exiting...');
    process.exit();
  }

  private startLiveCheck(): void {
    if (this.liveCheckLoop) {
      clearInterval(this.liveCheckLoop);
    }

    this.liveCheckLoop = setInterval(async () => {
      if (this.restarting) {
        return;
      }

      try {
        if (
          !this.pid ||
          !this.ffmpeg ||
          this.ffmpeg.killed ||
          this.ffmpeg.exitCode !== null ||
          !this.ffmpeg.stdin.writable
        ) {
          Logger.warn('FFmpeg process is not running, restarting stream');
          await this.restartStream();

          return;
        }

        if (this.liveCheckAPIEnabled) {
          const response = await fetch(this.liveCheckUrl, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            Logger.error(`Live check failed with status ${response.status}`);
            return;
          }

          const data = await response.json() as { live?: unknown };
          if (data.live === false) {
            this.liveCheckFalseCount++;
            if (this.liveCheckFalseCount >= this.liveCheckFalseThreshold) {
              Logger.warn(`Live check reported stream offline ${this.liveCheckFalseCount} times, restarting stream`);
              this.liveCheckFalseCount = 0;
              await this.restartStream();
            } else {
              Logger.warn(`Live check reported stream offline (${this.liveCheckFalseCount}/${this.liveCheckFalseThreshold})`);
            }
          } else if (data.live === true) {
            this.liveCheckFalseCount = 0;
          }
        }
      } catch (err) {
        Logger.error('Error during live check:', (err as Error).message);
      }
    }, this.liveCheckInterval);
  }

  private spawnFFmpeg(): ChildProcessWithoutNullStreams {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-re',
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-r', '30',
      '-thread_queue_size', '64',
      '-i', '-',
      '-i', 'music.mp3',
      '-filter_complex', '[1:a]aloop=loop=-1:size=2e9[aout]',
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-b:v', '5000k',
      '-minrate', '5000k',
      '-maxrate', '5000k',
      '-bufsize', '10000k',
      '-x264-params', 'nal-hrd=cbr',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'flv',
      `rtmp://127.0.0.1:1935/live/potato`,
    ]);

    const startedAt = Date.now();

    this.pid = ffmpeg.pid;
    this.ffmpeg = ffmpeg;

    this.cleanupFFmpeg = async (): Promise<void> => {
      try {
        Logger.warn('Cleaning up FFmpeg...');
        ffmpeg.stdin.end();
        ffmpeg.stdout.destroy();
        ffmpeg.stderr.destroy();
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

    // A write can race the process dying; the close handler does the recovery.
    ffmpeg.stdin.on('error', (err) => {
      Logger.warn('FFmpeg stdin error:', err.message);
    });

    ffmpeg.on('close', (code, signal) => {
      if (this.ffmpeg !== ffmpeg) {
        return;
      }

      const crashedEarly = Date.now() - startedAt < FFMPEG_STABLE_UPTIME_MS;
      this.ffmpegCrashCount = crashedEarly ? this.ffmpegCrashCount + 1 : 0;
      this.pid = undefined;
      this.ffmpeg = undefined;

      const delay = restartDelay(this.ffmpegCrashCount);
      Logger.warn(`FFmpeg exited (code ${code}, signal ${signal}), restarting it in ${delay}ms`);
      this.scheduleRestart(delay, 'ffmpeg');
    });

    this.startLiveCheck();

    return ffmpeg;
  }

  private async startStreaming(ffmpeg: ChildProcessWithoutNullStreams): Promise<void> {
    while (true) {
      if (!ffmpeg.stdin.writable) {
        break;
      }

      try {
        // Skip the frame rather than queue it without limit if FFmpeg falls behind.
        if (this.currentFrame.frame.length && !ffmpeg.stdin.writableNeedDrain) {
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
    const browserConfig: LaunchOptions = {
      headless: true,
      protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
      args: ['--window-size=1920,1080', '--no-sandbox'],
    };

    if (this.config.executablePath) {
      browserConfig.executablePath = this.config.executablePath;
    }

    return puppeteer.launch(browserConfig);
  }

  private updateCookies(browser: Browser, cookies: CookieData[]): NodeJS.Timeout {
    return setInterval(async () => {
      try {
        const newCookies = await browser.cookies();
        if (JSON.stringify(cookies) !== JSON.stringify(newCookies)) {
          writeFileSync('cookies.json', JSON.stringify(newCookies));
          cookies = newCookies;
        }
      } catch (err) {
        Logger.warn(`Failed to update cookies: ${(err as Error).message}`);
      }
    }, 10000);
  }

  private async loadPage(page: Page): Promise<void> {
    await page.goto(this.config.url, { waitUntil: 'domcontentloaded' });

    // Redirected to the login page, which will never match readySelector.
    if (this.config.grafanaEnabled && page.url() !== this.config.url) {
      return;
    }

    // Live pages may never go network idle, so this wait is best effort.
    try {
      if (this.config.readySelector) {
        await page.waitForSelector(this.config.readySelector, { timeout: PAGE_SETTLE_TIMEOUT_MS });
      } else {
        await page.waitForNetworkIdle({ idleTime: 500, timeout: PAGE_SETTLE_TIMEOUT_MS });
      }
    } catch {
      Logger.warn(`Page not settled after ${PAGE_SETTLE_TIMEOUT_MS}ms, continuing`);
    }
  }

  private async getClient(browser: Browser): Promise<CDPSession> {
    const page = await browser.newPage();

    this.page = page;
    this.broker.setPage = page;

    page.on('error', (err) => {
      if (page === this.page) {
        Logger.warn(`Page crashed: ${err.message}`);
        this.scheduleRestart(0, 'page');
      }
    });

    await page.setViewport({ width: 1920, height: 1080 });

    if (this.config.injectedCss.length) {
      await page.evaluateOnNewDocument(injectStyle, this.config.injectedCss);
    }

    await this.loadPage(page);

    if (this.config.grafanaEnabled) {
      if (page.url() !== this.config.url) {
        Logger.warn('Cookies expired... signing into Grafana');
        await this.signIntoGrafana();
        await this.loadPage(page);
        if (page.url() !== this.config.url) {
          throw new Error('Failed to sign into Grafana');
        }
      }

      // 403s only: Grafana answers expired sessions with a 401 that it refreshes itself.
      const origin = new URL(this.config.url).origin;
      page.on('response', (response) => {
        if (response.status() === 403 && new URL(response.url()).origin === origin) {
          this.refreshGrafanaSession(page);
        }
      });
    }

    if (this.config.injectedCss.length) {
      try {
        await page.click('#dock-menu-button');
      } catch {
        Logger.warn('Dock menu button not found, skipping click for CSS injection');
      }
    }

    clearInterval(this.reloadLoop);
    this.reloadLoop = setInterval(() => {
      page.reload().catch((err) => {
        Logger.warn(`Scheduled page reload failed: ${(err as Error).message}`);
      });
    }, PAGE_RELOAD_INTERVAL_MS);

    return page.createCDPSession();
  }

  private async refreshGrafanaSession(page: Page): Promise<void> {
    if (this.signingIn || Date.now() - this.lastSignInAt < GRAFANA_SIGN_IN_COOLDOWN_MS) {
      return;
    }

    this.signingIn = true;
    this.lastSignInAt = Date.now();

    try {
      Logger.warn('Cookies have expired... signing into Grafana');
      await this.signIntoGrafana();
      await this.loadPage(page);
      if (page.url() !== this.config.url) {
        throw new Error('Failed to re-sign into Grafana');
      }
    } catch (err) {
      Logger.error('Grafana session refresh failed:', (err as Error).message);
    } finally {
      this.signingIn = false;
    }
  }

  private async signIntoGrafana(): Promise<void> {
    if (!this.browserSession) {
      throw new Error('Browser session not initialized');
    }

    const browser = this.browserSession;
    const page = await browser.newPage();

    try {
      await page.goto(this.config.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="data-testid Username input field"]');

      await page.type('[data-testid="data-testid Username input field"]', this.config.grafanaUser);
      await page.type('[data-testid="data-testid Password input field"]', this.config.grafanaPass);

      Logger.debug('Logging in...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('[data-testid="data-testid Login button"]'),
      ]);

      Logger.debug('Logged in, updating cookies...');
      const cookies = await browser.cookies();
      writeFileSync('cookies.json', JSON.stringify(cookies));

      clearInterval(this.cookieLoop);
      this.cookieLoop = this.updateCookies(browser, cookies);

      Logger.warn('Signed into Grafana!');
    } finally {
      await page.close();
    }
  }

  private startFFmpeg(): void {
    this.startStreaming(this.spawnFFmpeg());
  }

  private async startPage(): Promise<void> {
    const browser = await this.getBrowser();
    this.browserSession = browser;
    Logger.debug('Created browser');

    browser.once('disconnected', () => {
      if (browser === this.browserSession) {
        Logger.warn('Browser disconnected, restarting page');
        this.browserSession = undefined;
        this.scheduleRestart(0, 'page');
      }
    });

    const cookies = JSON.parse(readFileSync('cookies.json', 'utf8'));
    await browser.setCookie(...cookies);

    this.cookieLoop = this.updateCookies(browser, cookies);

    const client = await this.getClient(browser);
    Logger.debug('Created page and client');

    await client.send('Page.enable');
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
    this.clientListener = client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      this.currentFrame.frame = Buffer.from(data, 'base64');
      await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });

    Logger.debug('Started screencast');
  }
}

export const streamer = new Streamer(configuration);
