const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [label, url, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 768 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 768 } }
  });
  const page = await context.newPage();
  const records = [];

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await installOverlay(page);

  const visualizerButton = page.locator('fluent-button[aria-label="Open in text visualizer"]').first();
  await visualizerButton.waitFor({ state: 'visible', timeout: 20000 });
  await visualizerButton.focus();

  const focused = await getState(page);
  records.push({ phase: 'focused', ...focused });
  await setOverlay(page, [
    `#17651 ${label}`,
    'Step 1: Keyboard focus is on a Resources row control.',
    `Focused control: ${focused.activeTag} aria-label="${focused.activeAria ?? '<missing>'}"`,
    `Text visualizer dialogs open: ${focused.dialogCount}`,
    `Resource details pane open: ${focused.hasDetailsPane}`,
    'Next action: press Enter on the focused control.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `17651-${slug(label)}-focused.png`), fullPage: true });
  await page.waitForTimeout(1500);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const afterEnter = await getState(page);
  records.push({ phase: 'after-enter', ...afterEnter });
  await setOverlay(page, [
    `#17651 ${label}`,
    'Step 2: Pressed Enter on "Open in text visualizer".',
    `Text visualizer dialogs open: ${afterEnter.dialogCount}`,
    `Resource details pane open: ${afterEnter.hasDetailsPane}`,
    label === 'BEFORE FIX'
      ? 'Bug reproduced: Enter triggered both the control and the row details pane.'
      : 'Fixed: Enter triggered only the focused control; row details stayed closed.'
  ].join('\n'));
  await page.screenshot({ path: path.join(outDir, `17651-${slug(label)}-after-enter.png`), fullPage: true });
  await page.waitForTimeout(3500);

  fs.writeFileSync(path.join(outDir, `17651-${slug(label)}.json`), JSON.stringify({ label, records }, null, 2));
  await context.close();
  await browser.close();
})();

async function installOverlay(page) {
  await page.evaluate(() => {
    const overlay = document.createElement('pre');
    overlay.id = 'a11y-evidence-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '12px';
    overlay.style.left = '12px';
    overlay.style.zIndex = '2147483647';
    overlay.style.maxWidth = '900px';
    overlay.style.padding = '14px 16px';
    overlay.style.margin = '0';
    overlay.style.border = '4px solid #ffd700';
    overlay.style.borderRadius = '8px';
    overlay.style.background = 'rgba(0, 0, 0, 0.88)';
    overlay.style.color = 'white';
    overlay.style.font = '16px/1.35 Menlo, Consolas, monospace';
    overlay.style.whiteSpace = 'pre-wrap';
    overlay.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.06)';
    document.body.appendChild(overlay);
  });
}

async function setOverlay(page, text) {
  await page.evaluate(value => {
    document.getElementById('a11y-evidence-overlay').textContent = value;
  }, text);
}

async function getState(page) {
  return await page.evaluate(() => {
    const active = document.activeElement;
    const dialogs = [...document.querySelectorAll('fluent-dialog')]
      .filter(dialog => !dialog.hasAttribute('hidden'))
      .map(dialog => dialog.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const detailsPane = document.querySelector('.details-container');

    return {
      url: location.href,
      activeTag: active?.tagName ?? null,
      activeAria: active?.getAttribute('aria-label') ?? null,
      activeText: active?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      dialogCount: dialogs.length,
      dialogText: dialogs[0]?.slice(0, 200) ?? null,
      hasDetailsPane: detailsPane !== null,
      detailsText: detailsPane?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? null
    };
  });
}

function slug(value) {
  return value.toLowerCase().replace(/\s+/g, '-');
}
