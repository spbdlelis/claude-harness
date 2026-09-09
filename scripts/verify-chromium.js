// Build-time sanity check for the headless-Chromium setup baked into the
// `claude` image stage (see Dockerfile). Runs once during `docker build`,
// not at container runtime, so it exercises the image regardless of the
// outbound proxy allowlist.
//
// @sparticuz/chromium and puppeteer-core are ESM-only packages; `.default`
// is needed for the former because it only has a default export (a class
// with static methods), while puppeteer-core also exposes `launch` as a
// named export.
const { execSync } = require('child_process');
const chromium = require('@sparticuz/chromium').default;
const puppeteer = require('puppeteer-core');

(async () => {
  const executablePath = await chromium.executablePath();
  console.log('[verify-chromium] executablePath:', executablePath);

  const ldd = execSync(`ldd ${executablePath}`).toString();
  const missing = ldd.split('\n').filter((line) => line.includes('not found'));
  if (missing.length) {
    console.error('[verify-chromium] Missing shared libraries:\n' + missing.join('\n'));
    process.exit(1);
  }
  console.log('[verify-chromium] All shared libraries resolved.');

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto('data:text/html,<h1>ok</h1>');
  const text = await page.$eval('h1', (el) => el.textContent);
  await browser.close();

  if (text !== 'ok') {
    console.error(`[verify-chromium] Unexpected page content: ${text}`);
    process.exit(1);
  }
  console.log('[verify-chromium] Headless launch + render OK.');
})().catch((err) => {
  console.error('[verify-chromium] FAILED:', err);
  process.exit(1);
});
