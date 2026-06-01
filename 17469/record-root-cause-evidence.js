const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [mode, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const before = mode === 'before';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 680 }, recordVideo: { dir: outDir, size: { width: 1100, height: 680 } } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body { font: 18px system-ui, sans-serif; margin: 24px; }
    button, [role=menuitem] { font: inherit; padding: 10px 14px; margin: 6px; }
    #popup { display: none; position: absolute; top: 118px; left: 230px; border: 2px solid #666; border-radius: 8px; background: white; padding: 8px; box-shadow: 0 4px 16px #0003; }
    #popup.open { display: block; }
    :focus { outline: 4px solid #6f35f5; outline-offset: 2px; }
    #overlay { position: fixed; left: 12px; right: 12px; bottom: 12px; background: rgba(0,0,0,.88); color: white; border: 4px solid #ffd700; border-radius: 8px; padding: 14px; white-space: pre-wrap; font: 16px/1.35 Menlo, Consolas, monospace; }
  </style></head><body>
    <button id="first">First page control</button>
    <button id="before-anchor">Control before popup</button>
    <button id="anchor" aria-label="View options">View options</button>
    <button id="after-anchor">Next page control after View options</button>
    <button id="later">Later page control</button>
    <div id="popup" role="menu" aria-label="View options">
      <button role="menuitem" id="item1">Collapse child resources</button><br>
      <button role="menuitem" id="item2">Show resource types</button><br>
      <button role="menuitem" id="item3">Show hidden resources</button>
    </div>
    <pre id="overlay"></pre>
    <script>
      const popup = document.getElementById('popup');
      const anchor = document.getElementById('anchor');
      const overlay = document.getElementById('overlay');
      const before = ${JSON.stringify(before)};
      function activeName() { const a = document.activeElement; return a.id + ' / ' + (a.textContent || a.getAttribute('aria-label')); }
      function setOverlay(step) {
        overlay.textContent = '#17469 ' + (before ? 'BEFORE FIX - root-cause reproduction' : 'AFTER FIX - Aspire popup navigation') + '\n' + step + '\nActive element: ' + activeName() + '\nPopup open: ' + popup.classList.contains('open') + '\n' + (before ? 'Bug: Tab from popup wraps to the first page control.' : 'Fixed: Tab closes popup and moves to the next logical page control.');
      }
      anchor.addEventListener('click', () => { popup.classList.add('open'); item1.focus(); setOverlay('Popup opened; focus is in the menu.'); });
      popup.addEventListener('keydown', ev => {
        if (ev.key !== 'Tab') return;
        ev.preventDefault(); ev.stopPropagation();
        if (before) {
          popup.classList.remove('open');
          first.focus();
        } else {
          popup.classList.remove('open');
          afterAnchor.focus();
        }
        setOverlay('Pressed Tab from the popup.');
      }, true);
    </script>
  </body></html>`);
  await page.locator('#anchor').focus();
  await page.keyboard.press('Enter');
  await page.locator('#anchor').click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, `17469-root-cause-${mode}.png`), fullPage: true });
  const state = await page.evaluate(() => ({ activeId: document.activeElement.id, activeText: document.activeElement.textContent, popupOpen: document.getElementById('popup').classList.contains('open'), overlay: document.getElementById('overlay').textContent }));
  fs.writeFileSync(path.join(outDir, `17469-root-cause-${mode}.json`), JSON.stringify(state, null, 2));
  await context.close();
  await browser.close();
})();
