const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const path = require('path');

async function recordDemo() {
  console.log("🚀 Launching local native browser (Puppeteer)...");
  const browser = await puppeteer.launch({ 
    headless: "new",
    defaultViewport: { width: 1920, height: 1080 }
  });
  
  const page = await browser.newPage();
  
  const Config = {
    followNewTab: true,
    fps: 30,
    videoFrame: { width: 1920, height: 1080 },
    videoCodec: 'libx264',
    videoPreset: 'ultrafast',
    videoBitrate: 8000,
    autopad: { color: 'black' }
  };

  const recorder = new PuppeteerScreenRecorder(page, Config);
  const savePath = path.join(process.cwd(), 'PocketChange_Demo.mp4');
  
  console.log("🎥 Starting screen recording...");
  await recorder.start(savePath);

  console.log("🌐 Navigating to http://localhost:3000 ...");
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log("⏳ Waiting for Next.js hydration to settle (8s)...");
  await new Promise(r => setTimeout(r, 8000));

  console.log("📜 Scrolling down to Staking Interface and Stats...");
  await page.evaluate(() => {
    window.scrollBy({ top: 800, behavior: 'smooth' });
  });
  await new Promise(r => setTimeout(r, 3000));

  console.log("📜 Scrolling down to Live Trades...");
  await page.evaluate(() => {
    window.scrollBy({ top: 800, behavior: 'smooth' });
  });
  await new Promise(r => setTimeout(r, 4000));

  console.log("📜 Scrolling back to top...");
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await new Promise(r => setTimeout(r, 3000));

  console.log("🛑 Stopping recorder...");
  await recorder.stop();
  await browser.close();

  console.log(`✅ Demo successfully recorded and saved to: ${savePath}`);
  process.exit(0);
}

recordDemo().catch(console.error);
