const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function recordPlaywright() {
  console.log("🚀 Launching Playwright Chromium...");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    recordVideo: { dir: __dirname, size: { width: 1920, height: 1080 } },
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  
  console.log("🌐 Navigating to http://localhost:3000 ...");
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Inject a visual cursor so the interactions are visible in the video
  console.log("🖱️ Injecting visual mouse cursor into page...");
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.style.width = '24px';
    cursor.style.height = '24px';
    cursor.style.borderRadius = '50%';
    cursor.style.backgroundColor = 'rgba(255, 50, 50, 0.6)';
    cursor.style.border = '2px solid white';
    cursor.style.position = 'fixed';
    cursor.style.pointerEvents = 'none';
    cursor.style.zIndex = '999999';
    cursor.style.transform = 'translate(-50%, -50%)';
    cursor.style.transition = 'transform 0.1s ease-out';
    document.body.appendChild(cursor);

    document.addEventListener('mousemove', e => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    });
    document.addEventListener('mousedown', () => cursor.style.transform = 'translate(-50%, -50%) scale(0.6)');
    document.addEventListener('mouseup', () => cursor.style.transform = 'translate(-50%, -50%) scale(1)');
  });

  // Helper to move mouse to an element smoothly and click
  async function smoothClick(selector) {
    const element = await page.$(selector);
    if (!element) return false;
    const box = await element.boundingBox();
    if (!box) return false;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 25 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    return true;
  }

  // 1. Hover/Click Wallet Connect
  console.log("👉 Interacting with Wallet Connect Modal...");
  await smoothClick('button.wallet-adapter-button');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  // 2. Scroll to Staking
  console.log("📜 Scrolling to Staking Interface...");
  await page.evaluate(() => window.scrollBy({ top: 800, behavior: 'smooth' }));
  await page.waitForTimeout(2000);

  // 3. Type Stake Amount
  console.log("⌨️ Typing Stake Amount...");
  const clickedInput = await smoothClick('input[type="number"]');
  if (clickedInput) {
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.type('25000', { delay: 150 });
  }
  await page.waitForTimeout(1500);

  // 4. Toggle Tabs
  console.log("🔄 Toggling Staking/Unstaking Tabs...");
  await smoothClick('button:has-text("Unstake")');
  await page.waitForTimeout(1500);
  await smoothClick('button:has-text("Stake USDC")');
  await page.waitForTimeout(2000);

  // 5. Scroll Down
  console.log("📜 Scrolling down to Live Trades feed...");
  await page.evaluate(() => window.scrollBy({ top: 800, behavior: 'smooth' }));
  await page.waitForTimeout(2000);

  console.log("🖱️ Hovering over transaction hash...");
  const hashElement = await page.$('td.font-mono');
  if (hashElement) {
    const box = await hashElement.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  }
  await page.waitForTimeout(2500);

  console.log("📜 Scrolling back to top...");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(3000);
  
  console.log("🛑 Finalizing WEBM recording...");
  const videoPath = await page.video().path();
  await context.close();
  await browser.close();
  
  const finalPath = path.join(__dirname, 'PocketChange_Demo_Visual.webm');
  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  fs.renameSync(videoPath, finalPath);
  console.log(`✅ Visual Demo successfully recorded and saved to: ${finalPath}`);
}

recordPlaywright().catch(console.error);
