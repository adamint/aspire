const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [label, url, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 768 }, recordVideo: { dir: outDir, size: { width: 1280, height: 768 } } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  const button = page.getByRole('button', { name: 'View options' });
  await button.focus();
  await button.press('Enter');
  await page.waitForTimeout(500);
  const beforeTab = await getState(page);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);
  const afterTab = await getState(page);
  await installOverlay(page);
  await setOverlay(page, [
    `#17469 ${label}`,
    'Action: Open View options, then press Tab.',
    `Menu open before Tab: ${beforeTab.menuOpen}`,
    `Menu open after Tab: ${afterTab.menuOpen}`,
    `Focus after Tab: ${afterTab.active.tag} ${afterTab.active.ariaLabel || afterTab.active.text || '<no name>'}`,
    label === 'BEFORE FIX'
      ? 'Bug: focus resets to the first page control instead of moving predictably from the popup trigger.'
      : 'Fixed: popup closes and focus moves predictably to the next page-order control.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `17469-${slug(label)}.png`), fullPage: true });
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(outDir, `17469-${slug(label)}.json`), JSON.stringify({ label, beforeTab, afterTab }, null, 2));
  await context.close();
  await browser.close();
})();

async function getState(page) {
  return await page.evaluate(() => {
    const active = document.activeElement;
    const menus = [...document.querySelectorAll('fluent-menu')].filter(menu => !menu.hasAttribute('hidden'));
    return {
      menuOpen: menus.length > 0,
      menuText: menus.map(m => m.textContent.trim()).join(' | '),
      active: {
        tag: active?.tagName ?? null,
        id: active?.id ?? null,
        className: active?.className?.toString() ?? null,
        ariaLabel: active?.getAttribute('aria-label') ?? null,
        title: active?.getAttribute('title') ?? null,
        text: active?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null
      }
    };
  });
}

async function installOverlay(page) {
  await page.evaluate(() => {
    const overlay = document.createElement('pre');
    overlay.id = 'a11y-evidence-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '12px';
    overlay.style.left = '12px';
    overlay.style.zIndex = '2147483647';
    overlay.style.maxWidth = '840px';
    overlay.style.padding = '14px';
    overlay.style.border = '4px solid #ffd700';
    overlay.style.borderRadius = '8px';
    overlay.style.background = 'rgba(0,0,0,.88)';
    overlay.style.color = 'white';
    overlay.style.font = '16px/1.35 Menlo, Consolas, monospace';
    overlay.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(overlay);
  });
}
async function setOverlay(page, text) { await page.evaluate(v => document.getElementById('a11y-evidence-overlay').textContent = v, text); }
function slug(value) { return value.toLowerCase().replace(/\s+/g, '-'); }
