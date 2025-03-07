import puppeteer, { Browser, CookieData, LaunchOptions } from 'puppeteer';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import Logger from './logger.js';
import config from '../config.json' with { type: 'json' };
import { Broker } from './broker.js';
import { readFile } from 'fs/promises';

if (!config.streamKey || !config.grafanaUrl) {
  Logger.error('Please provide streamKey and grafanaUrl in config.json');
  process.exit(1);
}

const startupImage = await readFile('image.png').catch(() => {
  Logger.error('Could not read startup image');
  process.exit(1);
});

const currentFrame = {
  frame: startupImage,
};

const broker = new Broker();

await broker.connect();

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

  Logger.debug('Spawned FFmpeg');

  ffmpeg.stderr.on('data', (data) => {
    Logger.debug('FFmpeg: '.concat(data.toString()));
  });

  ffmpeg.on('exit', () => {
    Logger.error('FFmpeg exited');
  });

  return ffmpeg;
};

const startStreaming = async (ffmpeg: ChildProcessWithoutNullStreams) => {
  while (true) {
    if (currentFrame) {
      ffmpeg.stdin.write(currentFrame.frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 / 30));
  }
};

const getBrowser = async () => {
  const browserConfig: LaunchOptions = {
    headless: true,
    args: ['--window-size=1920,1080'],
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
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(config.grafanaUrl, { waitUntil: 'networkidle0' });

  await page.click('#dock-menu-button');

  if (config.injectedCss) {
    await page.addStyleTag({ content: config.injectedCss });
  }

  return page.createCDPSession();
};

(async () => {
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
})();
