const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function recordPlaywright() {
  console.log("🚀 Launching Playwright Chromium for Comprehensive Demo...");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    recordVideo: { dir: __dirname, size: { width: 1920, height: 1080 } },
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  
  console.log("🌐 Navigating to http://localhost:3000 ...");
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

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

  async function smoothClick(selector) {
    const element = await page.$(selector);
    if (!element) return false;
    const box = await element.boundingBox();
    if (!box) return false;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 20 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    return true;
  }

  // 1. Dashboard Overview
  console.log("👀 Viewing Dashboard Overview...");
  await page.waitForTimeout(3000);

  // 2. Scanner
  console.log("🔍 Navigating to Scanner...");
  await smoothClick('button:has-text("Scanner")');
  await page.waitForTimeout(4000);

  // 3. Strategy
  console.log("⚙️ Navigating to Strategy Builder...");
  await smoothClick('button:has-text("Strategy")');
  await page.waitForTimeout(4000);

  // 4. Analytics
  console.log("📊 Navigating to Analytics...");
  await smoothClick('button:has-text("Analytics")');
  await page.waitForTimeout(4000);

  // 5. Tokenomics
  console.log("💰 Navigating to Tokenomics...");
  await smoothClick('button:has-text("Tokenomics")');
  await page.waitForTimeout(4000);

  // 6. Security
  console.log("🛡️ Navigating to Security...");
  await smoothClick('button:has-text("Security")');
  await page.waitForTimeout(4000);

  // 7. Back to Dashboard & Execution Demo
  console.log("🏠 Returning to Dashboard for Execution Demo...");
  await smoothClick('button:has-text("Dashboard")');
  await page.waitForTimeout(2000);
  
  await smoothClick('button.wallet-adapter-button');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);

  console.log("📜 Scrolling to Staking Interface...");
  await page.evaluate(() => window.scrollBy({ top: 800, behavior: 'smooth' }));
  await page.waitForTimeout(2000);

  console.log("⌨️ Typing Stake Amount...");
  const clickedInput = await smoothClick('input[type="number"]');
  if (clickedInput) {
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    await page.keyboard.type('50000', { delay: 100 });
  }
  await page.waitForTimeout(1500);

  console.log("🛑 Finalizing Comprehensive WEBM recording...");
  const videoPath = await page.video().path();
  await context.close();
  await browser.close();
  
  const finalPath = path.join(__dirname, 'PocketChange_Comprehensive_Demo.webm');
  if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  fs.renameSync(videoPath, finalPath);
  console.log(`✅ Comprehensive Demo successfully recorded and saved to: ${finalPath}`);
}

recordPlaywright().catch(console.error);
