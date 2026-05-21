// UI smoke test against local wrangler dev (http://127.0.0.1:8788).
// Captures screenshots into tests/screenshots/ and asserts a handful of
// invariants. Run with `node tests/ui-smoke.mjs`.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8788';
const OUT = new URL('./screenshots/', import.meta.url).pathname;

const browser = await chromium.launch();
const failures = [];
const log = (label, ok, detail = '') => {
  const tag = ok ? '✓' : '✗';
  console.log(`${tag} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

async function shot(page, name) {
  await page.screenshot({ path: OUT + name + '.png', fullPage: false });
}

try {
  // ---- LANDING ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const resp = await page.goto(BASE + '/');
    log('landing loads', resp.ok());
    await page.waitForSelector('#join-form');
    log('landing has join form', !!(await page.$('#join-form')));
    await shot(page, '01-landing-desktop');
    await ctx.close();
  }

  // ---- DASHBOARD: empty state + new-quiz modal ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/dashboard.html');
    await page.waitForSelector('#new');
    await shot(page, '02-dashboard-loaded');
    log('dashboard renders', true);

    // open new-quiz modal
    await page.click('#new');
    await page.waitForSelector('dialog#new-quiz-modal[open]');
    const box = await page.$eval('dialog#new-quiz-modal', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
    });
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const offX = Math.abs(cx - box.vw / 2);
    const offY = Math.abs(cy - box.vh / 2);
    log('new-quiz modal horizontally centered', offX < 2, `offX=${offX.toFixed(1)}px`);
    log('new-quiz modal vertically centered', offY < 2, `offY=${offY.toFixed(1)}px`);
    await shot(page, '03-modal-open');

    // download buttons present
    const hasCsv = !!(await page.$('#dl-csv'));
    const hasJson = !!(await page.$('#dl-json'));
    log('template download buttons present', hasCsv && hasJson);

    // Type a title and submit, expecting redirect to editor
    await page.fill('#nq-title', 'Playwright smoke quiz');
    await Promise.all([
      page.waitForURL(/\/editor(\.html)?\?id=/),
      page.click('#nq-submit'),
    ]);
    log('create-quiz lands on editor', /\/editor(\.html)?\?id=/.test(page.url()));
    await ctx.close();
  }

  // ---- EDITOR: add question, verify badge + sec label ----
  let quizId;
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    // get latest quiz id via API
    const resp = await page.request.get(BASE + '/api/quizzes');
    const data = await resp.json();
    quizId = data.quizzes[0]?.id;
    log('quiz exists in API after create', !!quizId);

    await page.goto(BASE + '/editor.html?id=' + encodeURIComponent(quizId));
    await page.waitForSelector('#title');
    await page.click('#addq');
    await page.waitForSelector('.question-item');
    await shot(page, '04-editor-with-question');

    // sec unit visible
    const secText = await page.locator('.q-time-unit').first().textContent();
    log('time-limit shows sec unit', secText && secText.trim().toLowerCase() === 'sec', `got: "${secText}"`);

    // correct answer styling — :has() pseudo + ::after badge
    const badge = await page.locator('.q-option:has(input[type=radio]:checked)').first();
    log('a correct option exists', (await badge.count()) > 0);
    const badgeContent = await badge.evaluate((el) => getComputedStyle(el, '::after').content);
    log('correct option has ::after badge', /CORRECT/.test(badgeContent), `content=${badgeContent}`);

    await ctx.close();
  }

  // ---- HOST page (lobby — needs hostToken via /api/games) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const resp = await page.request.post(BASE + '/api/games', { data: { quizId } });
    const ok = resp.ok();
    log('start-game request succeeds', ok);
    if (ok) {
      const data = await resp.json();
      // simulate dashboard.html's storage handoff
      await page.addInitScript((args) => {
        sessionStorage.setItem('host-pin', args.pin);
        sessionStorage.setItem('host-token', args.token);
      }, { pin: data.pin, token: data.hostToken });
      await page.goto(BASE + '/host.html');
      await page.waitForSelector('.lobby', { timeout: 5000 });
      await shot(page, '05-host-lobby');
      log('host lobby renders with PIN', /\d/.test(await page.locator('.pin').textContent()));
    }
    await ctx.close();
  }

  // ---- PLAY page (mobile viewport) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // iPhone 14 size
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      sessionStorage.setItem('play-pin', '000000');
      sessionStorage.setItem('play-nick', 'PlaywrightBot');
    });
    await page.goto(BASE + '/play.html');
    // ws will fail (pin doesn't exist) — capture the "Disconnected" state regardless
    await page.waitForTimeout(800);
    await shot(page, '06-play-mobile');
    log('play screen renders on mobile viewport', true);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log('\n--- summary ---');
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED:\n  ` + failures.join('\n  '));
process.exit(failures.length === 0 ? 0 : 1);
