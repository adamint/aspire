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
  const help = page.locator('fluent-button[aria-label="Help"], fluent-button[title="Help"]').first();
  await help.focus();
  const beforeOpen = await getState(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const open = await getState(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  const closed = await getState(page);
  await installOverlay(page);
  await setOverlay(page, [
    `#10119 ${label}`,
    'Action: focus Help, press Enter, close dialog with Escape.',
    `Before open focus: ${formatActive(beforeOpen.active)}`,
    `Dialog open focus: ${formatActive(open.active)}`,
    `After close focus: ${formatActive(closed.active)}`,
    label === 'BEFORE FIX'
      ? 'Bug: focus falls back to BODY after closing the dialog.'
      : 'Fixed: focus returns to the Help launcher button.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `10119-${slug(label)}.png`), fullPage: true });
  await page.waitForTimeout(3000);
  fs.writeFileSync(path.join(outDir, `10119-${slug(label)}.json`), JSON.stringify({ label, beforeOpen, open, closed }, null, 2));
  await context.close();
  await browser.close();
})();

function formatActive(active) {
  return `${active.tag}#${active.id || '<none>'} ${active.aria || active.title || active.text || '<no name>'}`;
}
async function getState(page) {
  return await page.evaluate(() => {
    const active = document.activeElement;
    return {
      active: {
        tag: active?.tagName ?? null,
        id: active?.id ?? null,
        aria: active?.getAttribute('aria-label') ?? null,
        title: active?.getAttribute('title') ?? null,
        text: active?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null
      },
      dialogs: [...document.querySelectorAll('fluent-dialog')].map(d => ({ hidden: d.hasAttribute('hidden'), text: d.textContent.trim().slice(0, 200) }))
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
    overlay.style.maxWidth = '900px';
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
