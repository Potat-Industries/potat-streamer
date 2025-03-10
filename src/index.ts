import puppeteer, { Browser, CookieData, LaunchOptions } from 'puppeteer';
import { readFileSync, writeFileSync } from 'fs';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import Logger from './logger.js';
import config from '../config.json' with { type: 'json' };
import { Broker } from './broker.js';
import { readFile } from 'fs/promises';
import kill from 'tree-kill';

if (!config.streamKey || !config.grafanaUrl) {
  Logger.error('Please provide streamKey and grafanaUrl in config.json');
  process.exit(1);
}

const startupImage = await readFile('image.png').catch(() => {
  Logger.error('Could not read startup image');
  process.exit(1);
});

const currentFrame: { frame: Buffer<ArrayBufferLike> } = {
  frame: startupImage,
};

const broker = new Broker();

await broker.connect();

let restarting = false;
let restartCount = 0;
let pid: number | undefined;
let cleanupFFmpeg: () => void = () => {};

export const restartStream = async () => {
  if (restartCount >= 5) {
    Logger.error('Restart limit reached. Exiting...');
    shutdownHook();
  }
  if (restarting) {
    return;
  }

  restarting = true;
  try {
    Logger.debug('Restarting stream...');
    await closeFFmpeg();
    broker.setPage = undefined;
    await initStream();
    Logger.debug('Stream restarted');
    return true;
  } catch (e) {
    Logger.error('Failed to restart stream:', (e as Error).message);
    return false;
  } finally {
    restarting = false;
    restartCount = 0;
  }
};

const closeFFmpeg = async () => {
  return new Promise((resolve) => {
    cleanupFFmpeg();
    if (pid) {
      Logger.warn(`Killing FFmpeg process with PID: ${pid}`);

      // Use tree-kill and spam it to ensure all child processes are killed.
      kill(pid, 'SIGKILL', (err) => {
        if (err) {
          Logger.error('Failed to kill FFmpeg process: ', (err as Error).message);
        } else {
          Logger.debug('FFmpeg process killed');
        }
      });
    } else {
      Logger.error('No FFmpeg process found to kill!');
    }

    pid = undefined;
    cleanupFFmpeg = () => {};

    Logger.debug('FFmpeg cleanup function reset');
    resolve(true);
  });
};

const shutdownHook = async () => {
  Logger.debug('Killing FFmpeg process...');
  closeFFmpeg();
  Logger.debug('Exiting...');
  process.exit();
};

process.on('SIGINT', shutdownHook);
process.on('SIGTERM', shutdownHook);
process.on('exit', shutdownHook);
process.on('uncaughtException', (err) => {
  Logger.error('Uncaught Exception:', (err as Error).message);
  ++restartCount;
  restartStream();
});
process.on('unhandledRejection', (reason) => {
  Logger.error('Unhandled Rejection:', (reason as Error).message);
  ++restartCount;
});

const spawnFFmpeg = async () => {
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
    `rtmp://live.twitch.tv/app/${config.streamKey}`,
  ]);

  pid = ffmpeg.pid;

  cleanupFFmpeg = async () => {
    try {
      Logger.debug('Cleaning up FFmpeg...');
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

  ffmpeg.on('exit', (code, signal) => {
    Logger.error(`FFmpeg exited with code ${code}, signal ${signal}`);
  });

  ffmpeg.on('error', (err) => {
    Logger.error('FFmpeg error:', (err as Error).message);
  });

  return ffmpeg;
};

const startStreaming = async (ffmpeg: ChildProcessWithoutNullStreams) => {
  while (true) {
    try {
      if (currentFrame.frame) {
        ffmpeg.stdin.write(currentFrame.frame);
      }
    } catch (err) {
      Logger.error('Error writing to FFmpeg stdin:', (err as Error).message);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
  }
};

const getBrowser = async () => {
  const browserConfig: LaunchOptions = {
    headless: true,
    args: ['--window-size=1920,1080', '--no-sandbox'],
  };

  if (config.executablePath) {
    browserConfig.executablePath = config.executablePath;
  }

  return puppeteer.launch(browserConfig);
};

const updateCookies = (browser: Browser, cookies: CookieData[]) => {
  return setInterval(async () => {
    const newCookies = await browser.cookies();
    if (JSON.stringify(cookies) !== JSON.stringify(newCookies)) {
      writeFileSync('cookies.json', JSON.stringify(newCookies));
      cookies = newCookies;
    }
  }, 10000);
};

const getClient = async (browser: Browser) => {
  const page = await browser.newPage();

  broker.setPage = page;

  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(config.grafanaUrl, { waitUntil: 'networkidle0' });

  if (config.injectedCss) {
    await page.click('#dock-menu-button');
    await page.addStyleTag({ content: config.injectedCss });
  }

  return page.createCDPSession();
};

const initStream = async () => {
  const ffmpeg = await spawnFFmpeg();

  startStreaming(ffmpeg);

  const browser = await getBrowser();
  Logger.debug('Created browser');

  const cookies = JSON.parse(readFileSync('cookies.json', 'utf8'));
  await browser.setCookie(...cookies);

  updateCookies(browser, cookies);

  const client = await getClient(browser);
  await client.send('Page.enable');
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    currentFrame.frame = Buffer.from(data, 'base64');
    await client.send('Page.screencastFrameAck', { sessionId });
  });

  Logger.debug('Started screencast');
};

initStream();
