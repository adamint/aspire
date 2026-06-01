const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [label, url, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 768 }, recordVideo: { dir: outDir, size: { width: 320, height: 768 } } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);
  await installOverlay(page);
  const state = await getState(page);
  await setOverlay(page, [
    `#17654 ${label}`,
    'Viewport: 320px wide reflow case.',
    `Visible tabs: ${state.tabs.filter(t => t.visible).map(t => t.text).join(', ') || '<none>'}`,
    `Overflow badge: ${state.badge.join(', ') || '<none>'}`,
    `Graph visible: ${state.graph?.visible}`,
    label === 'BEFORE FIX'
      ? 'Bug: Graph is selected/reachable only through overflow and is not visible in the tab row.'
      : 'Fixed: Resources, Parameters, and Graph are all visible in vertical reflow.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `17654-${slug(label)}.png`), fullPage: true });
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(outDir, `17654-${slug(label)}.json`), JSON.stringify({ label, state }, null, 2));
  await context.close();
  await browser.close();
})();

async function installOverlay(page) {
  await page.evaluate(() => {
    const overlay = document.createElement('pre');
    overlay.id = 'a11y-evidence-overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '8px';
    overlay.style.right = '8px';
    overlay.style.bottom = '8px';
    overlay.style.zIndex = '2147483647';
    overlay.style.padding = '10px';
    overlay.style.border = '3px solid #ffd700';
    overlay.style.borderRadius = '6px';
    overlay.style.background = 'rgba(0, 0, 0, 0.88)';
    overlay.style.color = 'white';
    overlay.style.font = '11px/1.3 Menlo, Consolas, monospace';
    overlay.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(overlay);
  });
}

async function setOverlay(page, text) {
  await page.evaluate(value => { document.getElementById('a11y-evidence-overlay').textContent = value; }, text);
}

async function getState(page) {
  return await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('fluent-tab')].map(t => {
      const r = t.getBoundingClientRect();
      return {
        text: t.textContent.trim(),
        overflow: t.hasAttribute('overflow'),
        fixed: t.hasAttribute('fixed'),
        selected: t.getAttribute('aria-selected'),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
        visible: r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight
      };
    });
    return { url: location.href, innerWidth, tabs, graph: tabs.find(t => t.text === 'Graph'), badge: [...document.querySelectorAll('fluent-badge')].map(b => b.textContent.trim()) };
  });
}

function slug(value) { return value.toLowerCase().replace(/\s+/g, '-'); }
