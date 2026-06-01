const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [label, url, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 640, height: 384 }, recordVideo: { dir: outDir, size: { width: 640, height: 384 } } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
  const nav = page.locator('#dashboard-navigation-button, fluent-button.navigation-button').first();
  await nav.click();
  await page.waitForTimeout(500);
  await installOverlay(page);
  const state = await getState(page);
  await setOverlay(page, [
    `#17657 ${label}`,
    'Viewport: 640x384 (models 1280x768 at 200% zoom).',
    `Menu style: ${state.menuStyle}`,
    `Menu bottom: ${Math.round(state.rect.bottom)} / viewport height: ${state.innerHeight}`,
    `Bottom within viewport: ${state.bottomWithinViewport}`,
    label === 'BEFORE FIX'
      ? 'Bug: menu scrollport extends below the visible viewport, so bottom focus can be obscured.'
      : 'Fixed: menu scrollport is constrained to the visible viewport.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `17657-${slug(label)}.png`), fullPage: true });
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(outDir, `17657-${slug(label)}.json`), JSON.stringify({ label, state }, null, 2));
  await context.close();
  await browser.close();
})();

async function installOverlay(page) {
  await page.evaluate(() => {
    const overlay = document.createElement('pre');
    overlay.id = 'a11y-evidence-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '8px';
    overlay.style.left = '8px';
    overlay.style.right = '8px';
    overlay.style.zIndex = '2147483647';
    overlay.style.padding = '10px 12px';
    overlay.style.margin = '0';
    overlay.style.border = '3px solid #ffd700';
    overlay.style.borderRadius = '6px';
    overlay.style.background = 'rgba(0, 0, 0, 0.88)';
    overlay.style.color = 'white';
    overlay.style.font = '12px/1.3 Menlo, Consolas, monospace';
    overlay.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(overlay);
  });
}

async function setOverlay(page, text) {
  await page.evaluate(value => { document.getElementById('a11y-evidence-overlay').textContent = value; }, text);
}

async function getState(page) {
  return await page.evaluate(() => {
    const menu = document.querySelector('fluent-menu.aspire-menu-container');
    const rect = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    return {
      url: location.href,
      innerHeight,
      menuStyle: menu.getAttribute('style'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      bottomWithinViewport: rect.bottom <= innerHeight,
      computedMaxHeight: style.maxHeight,
      computedHeight: style.height,
      overflowY: style.overflowY
    };
  });
}

function slug(value) { return value.toLowerCase().replace(/\s+/g, '-'); }
