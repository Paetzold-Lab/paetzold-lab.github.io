/* Optional real-browser checks. Requires `playwright`; see readme.md. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const filename = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) throw Error('outside root');
    const body = await fs.promises.readFile(filename);
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    // Never send test submissions or load third-party embeds over the network.
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.fulfill({ status: 200, body: '' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const pages = ['index.html', 'research.html', 'team.html', 'join_us.html', 'contact.html', 'pi.html',
      ...['Adina', 'Laurin', 'Lucas', 'Matt', 'Robert', 'Roel'].map(name => `team_members_subpage/${name}.html`)];

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of pages) {
        await page.goto(`${origin}/${name}`);
        await page.waitForSelector('.header .logo');
        await page.waitForFunction(() => document.querySelector('#current-year')?.textContent);
        if (name === 'index.html') await page.waitForSelector('.lab-intro-slide h2');
        if (name === 'research.html') await page.waitForSelector('.pub-item');
        assert.equal(await page.locator('#nav-logo').getAttribute('href'), `${origin}/index.html`);
        assert.ok(await page.locator('main h1').count(), `${name} has a heading`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow at ${width}px`);
        if (name.startsWith('team_members_subpage/')) assert.equal(await page.locator('#nav-team').getAttribute('aria-current'), 'page');
        assert.deepEqual(errors.splice(0), [], `${name} at ${width}px: browser errors`);
      }
    }
    console.log('PASS: all 12 pages at desktop and mobile widths, nested navigation, CSP, and console checks');

    await page.goto(`${origin}/index.html`);
    await page.waitForSelector('.pub-card');
    await page.locator('.search-btn').click();
    await page.locator('.search-input').fill('Chenjun');
    await page.waitForSelector('.search-results a');
    assert.ok((await page.locator('.search-results').textContent()).includes('Chenjun Li'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#search-overlay').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'search-btn');
    await page.locator('#open-legal-notice').click();
    assert.equal(await page.locator('#legal-notice-popup').getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'open-legal-notice');
    assert.equal(await page.locator('#carousel-indicators .dot').count(), 7);
    for (const index of [1, 2, 3, 4, 5, 6, 0]) {
      await page.locator('#carousel-indicators .dot').nth(index).click();
      assert.equal(await page.locator('#carousel-indicators .dot[aria-current="true"]').getAttribute('aria-label'),
        await page.locator('#carousel-indicators .dot').nth(index).getAttribute('aria-label'));
      await page.waitForFunction(() => {
        const hero = document.querySelector('.hero-carousel').getBoundingClientRect();
        const active = document.querySelector('.carousel-slide.active').getBoundingClientRect();
        const title = document.querySelector('.carousel-slide.active h2').getBoundingClientRect();
        return Math.abs(active.left - hero.left) < 1 && title.left >= hero.left && title.right <= hero.right + 1;
      });
    }
    await page.locator('#carousel-indicators .dot').nth(1).click();
    await page.locator('.carousel-slide.active .paper-collage-frame').first().click();
    assert.equal(await page.locator('#paper-zoom-modal').getAttribute('aria-hidden'), 'false');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#paper-zoom-modal').getAttribute('aria-hidden'), 'true');
    await page.locator('.pub-card-image img').first().evaluate(img => { img.src = 'data:image/png;base64,eA=='; });
    await page.waitForFunction(() => {
      const img = document.querySelector('.pub-card-image img');
      return img.naturalWidth > 0 && img.src.includes('/images/publications/default.png');
    });
    console.log('PASS: search, profile indexing, legal notice, paper preview, and focus restoration');
    console.log('PASS: existing publication image fallbacks remain functional');

    await page.goto(`${origin}/research.html?member=Chenjun%20Li`);
    await page.waitForSelector('.pub-item');
    assert.equal(await page.locator('.pub-member-filters .active').textContent(), 'Chenjun Li');
    await page.locator('.pub-search input').fill('   MELD   ');
    await page.waitForFunction(() => document.querySelectorAll('.pub-item').length === 1);
    assert.ok((await page.locator('.pub-item h3').textContent()).includes('MELD'));
    await page.locator('.pub-search input').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.pub-item').length === 5);
    await page.locator('.pagination-btn.next').click();
    assert.equal(await page.locator('.page-numbers [aria-current="page"]').textContent(), '2');
    await page.locator('#sort-select').selectOption('citations');
    assert.equal(await page.locator('.page-numbers [aria-current="page"]').textContent(), '1');
    console.log('PASS: publication URL parameters, whitespace search, filtering, pagination, and sorting');
    assert.deepEqual(errors.splice(0), [], 'unexpected browser interaction errors');

    await page.route('**/data/publications.json*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.goto(`${origin}/research.html`);
    await page.waitForSelector('#publications-container [role="alert"]');
    assert.equal(await page.locator('.pagination-btn.next').isDisabled(), true);
    await page.unroute('**/data/publications.json*');
    // The deliberately simulated HTTP failure is expected to log a network error.
    errors.splice(0);
    console.log('PASS: publication failure is distinguished from an empty search');

    await page.goto(`${origin}/contact.html`);
    await page.waitForSelector('#contact-website');
    await page.locator('#name').fill('Browser Test');
    await page.locator('#email').fill('test@example.org');
    await page.locator('#message').fill('   short   ');
    await page.locator('.submit-btn').click();
    assert.equal(await page.locator('#message').evaluate(el => el.checkValidity()), false);
    await page.locator('#message').fill('This is an automated test message.');
    await page.waitForTimeout(2600);
    let posts = 0;
    await page.route('https://script.google.com/**', route => {
      posts++;
      const data = JSON.parse(route.request().postData());
      assert.equal(data.email, 'test@example.org');
      assert.ok(data.elapsed >= 2500);
      assert.equal(route.request().headers()['content-type'], 'text/plain;charset=UTF-8');
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"ok":true}' });
    });
    await page.locator('.submit-btn').click();
    await page.waitForFunction(() => document.querySelector('.form-status').textContent.includes('message has been received'));
    assert.equal(posts, 1);
    assert.equal(await page.locator('#message').inputValue(), '');
    console.log('PASS: contact validation and mocked submission; no real email sent');

    await page.waitForFunction(() => !document.querySelector('.submit-btn').disabled);
    await page.locator('#name').fill('Browser Test');
    await page.locator('#email').fill('test@example.org');
    const retryMessage = 'Keep this message after a network failure.';
    await page.locator('#message').fill(retryMessage);
    await page.route('https://script.google.com/**', route => route.abort('internetdisconnected'));
    await page.locator('.submit-btn').click();
    await page.waitForFunction(() => document.querySelector('.form-status').textContent.includes('could not confirm delivery'));
    assert.equal(await page.locator('#message').inputValue(), retryMessage);
    await page.waitForFunction(() => !document.querySelector('.submit-btn').disabled);
    assert.equal(await page.locator('#contact-form').getAttribute('aria-busy'), null);
    // The deliberately aborted request is expected to log a network error.
    assert.ok(errors.every(message => message.includes('ERR_INTERNET_DISCONNECTED')), errors.join('\n'));
    errors.splice(0);
    console.log('PASS: transport failure preserves the message and allows a retry');

    assert.deepEqual(errors, [], 'unexpected browser errors');
    await context.close();

    for (const width of [1440, 390]) {
      const autoplayContext = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width, height: 1000 } });
      await autoplayContext.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.fulfill({ status: 200, body: '' }));
      const autoplayPage = await autoplayContext.newPage();
      const start = new Date('2026-10-16T12:00:00Z');
      await autoplayPage.clock.install({ time: start });
      await autoplayPage.clock.pauseAt(new Date(start.getTime() + 100));
      await autoplayPage.goto(`${origin}/index.html`);
      await autoplayPage.waitForSelector('.pub-card');
      assert.equal(await autoplayPage.locator('.carousel-slide').count(), 7);
      assert.equal(await autoplayPage.locator('.paper-collage[data-paper-id]').count(), 6);
      const activeIndex = () => autoplayPage.evaluate(() => [...document.querySelectorAll('.carousel-slide')].findIndex(slide => slide.classList.contains('active')));
      assert.equal(await activeIndex(), 0);
      for (let next = 1; next <= 7; next++) {
        await autoplayPage.clock.runFor(8100);
        assert.equal(await activeIndex(), next % 7, `autoplay at ${width}px, transition ${next}`);
        // CSS transitions run on the compositor's real timeline, separately
        // from the mocked JavaScript clock. Check the actual settled position.
        await new Promise(resolve => setTimeout(resolve, 750));
        const position = await autoplayPage.evaluate(() => {
          const hero = document.querySelector('.hero-carousel').getBoundingClientRect();
          const active = document.querySelector('.carousel-slide.active').getBoundingClientRect();
          const title = document.querySelector('.carousel-slide.active h2').getBoundingClientRect();
          return { aligned: Math.abs(active.left - hero.left) < 1, titleVisible: title.left >= hero.left && title.right <= hero.right + 1 };
        });
        assert.ok(position.aligned && position.titleVisible, `paper must be visible at ${width}px, transition ${next}`);
        assert.ok((await autoplayPage.locator('.carousel-slide.active h2').textContent()).trim());
      }
      console.log(`PASS: all six research slides visibly rotate and loop back to the introduction at ${width}px`);
      await autoplayContext.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
