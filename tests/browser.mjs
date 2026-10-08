import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync(localChrome) ? localChrome : undefined), headless: true });
const url = (process.env.PROTOTYPE_URL || 'http://127.0.0.1:4192').replace(/\/$/, '');
const outputs = new URL('../outputs/', import.meta.url);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
await mkdir(outputs, { recursive: true });
const errors = [], passed = [];
function watch(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
}
const blocks = page => page.locator('.cube').evaluateAll(elements => elements.map(el => ({
  id: el.id, source: el.dataset.source, color: el.dataset.color,
  column: Number(el.dataset.column), row: Number(el.dataset.row),
  width: Number(el.dataset.width), height: Number(el.dataset.height), dragging: el.dataset.dragging === 'true',
})));
function cells(items) {
  const occupied = new Map();
  for (const block of items) {
    assert.ok(block.column >= 0 && block.row >= 0 && block.column + block.width <= 18 && block.row + block.height <= 32);
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
      const key = `${block.column + x},${block.row + y}`;
      assert.ok(!occupied.has(key), `No overlap at ${key}`);
      occupied.set(key, `${block.source}:${block.color}`);
    }
  }
  return occupied;
}
function clearedCells(items) {
  // Independent oracle checks occupied cells rather than rectangle extents.
  const occupied = cells(items);
  const fullRows = Array.from({ length: 32 }, (_, y) => y).filter(y => Array.from({ length: 18 }, (_, x) => occupied.has(`${x},${y}`)).every(Boolean));
  const fullColumns = Array.from({ length: 18 }, (_, x) => x).filter(x => Array.from({ length: 32 }, (_, y) => occupied.has(`${x},${y}`)).every(Boolean));
  for (const key of occupied.keys()) {
    const [x, y] = key.split(',').map(Number);
    if (fullRows.includes(y) || fullColumns.includes(x)) occupied.delete(key);
  }
  return occupied;
}
const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b));
async function geometry(page, selector) {
  const field = await page.locator('#field').boundingBox();
  const cube = await page.locator(selector).boundingBox();
  const block = (await blocks(page)).find(item => `#${item.id}` === selector);
  assert.ok(block && cube);
  const cell = field.width / 18;
  assert.ok(Math.abs(field.height / 32 - cell) < 0.03, 'Square cells');
  assert.ok(Math.abs(cube.width - cell * block.width) < 0.04 && Math.abs(cube.height - cell * block.height) < 0.04, 'Actual rectangular dimensions');
  if (block.dragging) {
    const preview = await page.locator('#landing').boundingBox(); assert.ok(preview);
    assert.ok(Math.abs(preview.width - cube.width) < 0.04 && Math.abs(preview.height - cube.height) < 0.04, 'Preview matches the fragment');
    assert.ok(Math.abs(preview.x - field.x - block.column * cell) < 0.04 && Math.abs(preview.y - field.y - block.row * cell) < 0.04, 'Snapped preview');
    assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await page.locator('#landing').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    assert.equal(await page.locator('#landing').evaluate(el => el.style.getPropertyValue('--preview-color').trim()), await page.locator(selector).evaluate(el => getComputedStyle(el).getPropertyValue('--landing-color').trim()));
  } else {
    assert.ok(Math.abs(cube.x - field.x - block.column * cell) < 0.04 && Math.abs(cube.y - field.y - block.row * cell) < 0.04, 'Idle grid alignment');
  }
  assert.ok(cube.x >= field.x - 0.04 && cube.y >= field.y - 0.04 && cube.x + cube.width <= field.x + field.width + 0.04 && cube.y + cube.height <= field.y + field.height + 0.04);
  return { field, cube, block, cell };
}
async function nearest(page, selector, x, y) {
  const items = await blocks(page), selected = items.find(block => `#${block.id}` === selector);
  const occupied = cells(items.filter(block => block !== selected));
  const free = (column, row) => {
    for (let dy = 0; dy < selected.height; dy++) for (let dx = 0; dx < selected.width; dx++) if (occupied.has(`${column + dx},${row + dy}`)) return false;
    return true;
  };
  assert.ok(free(selected.column, selected.row));
  const chosen = (selected.column - x) ** 2 + (selected.row - y) ** 2;
  for (let row = 0; row <= 32 - selected.height; row++) for (let column = 0; column <= 18 - selected.width; column++) {
    if (free(column, row)) assert.ok(chosen <= (column - x) ** 2 + (row - y) ** 2 + 0.0051, 'Globally nearest preview, with subpixel ties');
  }
  const { field, cube, cell } = await geometry(page, selector);
  assert.ok(Math.abs(cube.x - field.x - x * cell) < 0.05 && Math.abs(cube.y - field.y - y * cell) < 0.05, 'Continuous visual movement');
}
async function startDrag(page, selector, x, y) {
  const { field, cube, cell, block } = await geometry(page, selector);
  await page.mouse.move(cube.x + cube.width * 0.3, cube.y + cube.height * 0.3); await page.mouse.down();
  await page.mouse.move(field.x + (x + block.width * 0.3) * cell, field.y + (y + block.height * 0.3) * cell);
  await nearest(page, selector, x, y);
}
async function release(page, end = () => page.mouse.up()) {
  const expected = clearedCells(await blocks(page)); await end();
  assert.deepEqual(sorted(cells(await blocks(page))), sorted(expected), 'Only full lines disappear; all other cells keep colour and position');
  assert.equal(await page.locator('#landing').isVisible(), false);
  for (const block of await blocks(page)) await geometry(page, `#${block.id}`);
}
async function drop(page, selector, x, y) { await startDrag(page, selector, x, y); await release(page); }
async function fixture(page, definitions) {
  const buttons = definitions.map(({ id, column, row, width = 1, height = 1, color = 'blue' }) => `<button id="${id}" class="cube" type="button" data-column="${column}" data-row="${row}" data-width="${width}" data-height="${height}" data-color="${color}" aria-label="Кубик" draggable="false"></button>`).join('\n');
  await page.unroute(`${url}/`);
  await page.route(`${url}/`, route => route.fulfill({ contentType: 'text/html', body: html.replace(/\s*<button\b[^>]*><\/button>/g, '').replace('  </main>', buttons + '\n  </main>') }));
  await page.goto(url); cells(await blocks(page));
}
const fragments = (items, source) => items.filter(block => block.source === source).map(({ column, row, width, height, color }) => ({ column, row, width, height, color })).sort((a, b) => a.row - b.row || a.column - b.column);
const rect = (column, row, width, height, color) => ({ column, row, width, height, color });
const selected = page => page.locator('.cube[data-selected="true"]').evaluateAll(elements => elements.map(el => el.id).sort());
async function marquee(page, from, to) {
  const field = await page.locator('#field').boundingBox(), cell = field.width / 18;
  await page.mouse.move(field.x + from[0] * cell, field.y + from[1] * cell);
  await page.mouse.down();
  await page.mouse.move(field.x + to[0] * cell, field.y + to[1] * cell);
}
const middle = [
  { id: 'large', ...rect(3, 5, 5, 5, 'peach') }, { id: 'left', ...rect(0, 7, 3, 1, 'blue') },
  { id: 'right', ...rect(8, 7, 9, 1, 'blue') }, { id: 'plug', ...rect(17, 20, 1, 1, 'gold') },
];
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage(); watch(page); await page.goto(url);
  const initial = await blocks(page); assert.equal(initial.length, 29); assert.equal(new Set(initial.map(item => item.color)).size, 29); cells(initial);
  assert.equal(await page.locator('body').innerText(), '');
  for (const item of initial) {
    await page.reload();
    await startDrag(page, `#${item.id}`, Math.min(18 - item.width, item.column + 0.6), Math.min(32 - item.height, item.row + 1.4));
    await release(page);
  }
  passed.push('All 29 blocks (sizes 1–6): smooth dragging, opaque colours, nearest free preview, bounds and exact drop/clear results');
  await page.reload(); await startDrag(page, '#cube-gold', 7.4, 14.3); await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await blocks(page), initial);
  await startDrag(page, '#cube', 9.6, 12.4); await page.setViewportSize({ width: 800, height: 500 });
  await page.waitForFunction(() => document.querySelector('#cube').dataset.dragging === 'false'); await page.mouse.up(); assert.deepEqual(await blocks(page), initial);
  await page.setViewportSize({ width: 1200, height: 900 }); passed.push('Escape and resize cancel without changing or clearing the field');

  await fixture(page, [
    { id: 'a', ...rect(2, 2, 3, 3, 'peach') },
    { id: 'b', ...rect(8, 4, 2, 2, 'blue') },
    { id: 'c', ...rect(14, 8, 1, 1, 'gold') },
  ]);
  const beforeSelection = await blocks(page);
  await marquee(page, [0.5, 0.5], [10.5, 7]);
  assert.equal(await page.locator('#selection-box').isVisible(), true);
  assert.deepEqual(await selected(page), ['a', 'b'], 'Live marquee selects intersecting blocks');
  assert.deepEqual(await blocks(page), beforeSelection, 'Selecting cannot move blocks or delete lines');
  await page.mouse.up();
  assert.equal(await page.locator('#selection-box').isVisible(), false);
  assert.deepEqual(await selected(page), ['a', 'b'], 'Selection survives release');
  assert.deepEqual(await page.locator('#a').evaluate(el => {
    const css = getComputedStyle(el);
    return [css.outlineColor, css.outlineStyle, css.outlineWidth, css.opacity, el.getAttribute('aria-pressed')];
  }), ['rgb(255, 255, 255)', 'solid', '3px', '1', 'true']);
  await marquee(page, [11, 7], [0.5, 0.5]); await page.mouse.up();
  assert.deepEqual(await selected(page), ['a', 'b'], 'Reverse-direction marquee works');
  await marquee(page, [0.5, 3], [2.5, 4]); await page.mouse.up();
  assert.deepEqual(await selected(page), ['a'], 'Partial intersection counts and a new frame replaces selection');
  await marquee(page, [0.5, 0.5], [17, 20]);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await selected(page), ['a'], 'Escape restores the prior selection');
  await marquee(page, [11, 7], [-5, -5]); await page.mouse.up();
  assert.deepEqual(await selected(page), ['a', 'b'], 'Capture supports release outside the field');
  await marquee(page, [0.5, 0.5], [17, 20]);
  await page.setViewportSize({ width: 800, height: 500 });
  await page.waitForFunction(() => document.querySelector('#selection-box').hidden);
  await page.mouse.up(); assert.deepEqual(await selected(page), ['a', 'b']);
  await page.setViewportSize({ width: 1200, height: 900 });
  await marquee(page, [0.5, 0.5], [0.5, 0.5]); await page.mouse.up();
  assert.deepEqual(await selected(page), [], 'Clicking empty space clears selection');
  assert.deepEqual(await blocks(page), beforeSelection);
  passed.push('Marquee selection: live white outlines, persistence, reverse/partial intersection, replacement, empty click, outside release and cancellation');

  await fixture(page, middle);
  await marquee(page, [1, 4], [9, 11]); await page.mouse.up();
  await startDrag(page, '#plug', 17, 7); assert.equal((await blocks(page)).length, 4, 'No deletion during drag'); await release(page);
  assert.equal((await selected(page)).length, 2, 'Surviving pieces inherit selection; deleted pieces leave no stale selection');
  assert.deepEqual(fragments(await blocks(page), 'large'), [rect(3, 5, 5, 2, 'peach'), rect(3, 8, 5, 2, 'peach')]);
  const lower = (await blocks(page)).find(item => item.row === 8), upper = (await blocks(page)).find(item => item.id === 'large');
  await drop(page, `#${lower.id}`, 0, 20); assert.deepEqual((await blocks(page)).find(item => item.id === 'large'), upper);
  await page.locator(`#${lower.id}`).focus(); await page.keyboard.press('ArrowRight'); assert.equal((await blocks(page)).find(item => item.id === lower.id).column, 1);
  await drop(page, `#${lower.id}`, 3, 7); await page.locator(`#${lower.id}`).focus(); await page.keyboard.press('ArrowUp'); assert.equal((await blocks(page)).find(item => item.id === lower.id).row, 7);
  passed.push('An interior row creates two independent rectangles with correct colour, dimensions, preview and mouse/keyboard collision checks');

  await fixture(page, [
    { id: 'large', ...rect(3, 5, 5, 6, 'peach') },
    ...[7, 9].flatMap(row => [{ id: `left-${row}`, ...rect(0, row, 3, 1, 'blue') }, { id: `right-${row}`, ...rect(8, row, 9, 1, 'blue') }]),
    { id: 'plug', ...rect(17, 20, 1, 3, 'gold') },
  ]);
  await drop(page, '#plug', 17, 7);
  assert.deepEqual(fragments(await blocks(page), 'large'), [rect(3, 5, 5, 2, 'peach'), rect(3, 8, 5, 1, 'peach'), rect(3, 10, 5, 1, 'peach')]);
  assert.deepEqual(fragments(await blocks(page), 'plug'), [rect(17, 8, 1, 1, 'gold')]); passed.push('Multiple separated rows cut both the placed and stationary blocks');

  await fixture(page, [
    { id: 'large', ...rect(6, 10, 5, 5, 'purple') }, { id: 'above', ...rect(8, 0, 1, 10, 'blue') },
    { id: 'below', ...rect(8, 15, 1, 16, 'blue') }, { id: 'plug', ...rect(17, 31, 1, 1, 'gold') },
  ]);
  await drop(page, '#plug', 8, 31); assert.deepEqual(fragments(await blocks(page), 'large'), [rect(6, 10, 2, 5, 'purple'), rect(9, 10, 2, 5, 'purple')]); passed.push('An interior column creates tall fragments');

  await fixture(page, [
    { id: 'large', ...rect(2, 6, 4, 4, 'lime') }, { id: 'above', ...rect(2, 0, 1, 6, 'blue') },
    { id: 'below', ...rect(2, 10, 1, 21, 'blue') }, { id: 'plug', ...rect(17, 31, 1, 1, 'gold') },
  ]);
  await page.locator('#plug').focus(); for (let x = 17; x > 2; x--) await page.keyboard.press('ArrowLeft');
  assert.deepEqual(fragments(await blocks(page), 'large'), [rect(3, 6, 3, 4, 'lime')]); passed.push('An edge cut resizes/repositions the survivor; keyboard completion clears a column');

  await fixture(page, [
    { id: 'large', ...rect(7, 14, 3, 3, 'mint') }, { id: 'left', ...rect(0, 15, 7, 1, 'blue') }, { id: 'right', ...rect(10, 15, 8, 1, 'blue') },
    { id: 'above', ...rect(8, 0, 1, 14, 'blue') }, { id: 'below', ...rect(8, 17, 1, 14, 'blue') }, { id: 'plug', ...rect(17, 31, 1, 1, 'gold') },
  ]);
  await startDrag(page, '#plug', 8, 31); await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal((await blocks(page)).length, 6, 'Cancellation cannot delete a prefilled line');
  await drop(page, '#plug', 8, 31);
  assert.deepEqual(fragments(await blocks(page), 'large'), [rect(7, 14, 1, 1, 'mint'), rect(9, 14, 1, 1, 'mint'), rect(7, 16, 1, 1, 'mint'), rect(9, 16, 1, 1, 'mint')]);
  assert.equal((await blocks(page)).length, 4); passed.push('Crossing row/column deletion is simultaneous and creates four corners');

  await fixture(page, [
    { id: 'large', ...rect(6, 13, 5, 5, 'cobalt') }, { id: 'left', ...rect(0, 15, 6, 1, 'blue') }, { id: 'right', ...rect(11, 15, 6, 1, 'blue') },
    { id: 'above', ...rect(8, 0, 1, 13, 'blue') }, { id: 'below', ...rect(8, 18, 1, 13, 'blue') },
    { id: 'plug', ...rect(17, 24, 1, 1, 'gold') }, { id: 'plug2', ...rect(16, 24, 1, 1, 'gold') }, { id: 'plug3', ...rect(15, 24, 1, 1, 'gold') },
  ]);
  await drop(page, '#plug', 17, 15); await drop(page, '#plug2', 8, 31); await drop(page, '#plug3', 8, 15);
  assert.deepEqual(fragments(await blocks(page), 'large'), [rect(6, 13, 2, 2, 'cobalt'), rect(9, 13, 2, 2, 'cobalt'), rect(6, 16, 2, 2, 'cobalt'), rect(9, 16, 2, 2, 'cobalt')]);
  assert.equal(new Set((await blocks(page)).map(item => item.id)).size, (await blocks(page)).length); passed.push('Later lines split already-cut fragments again without duplicate IDs');
  await fixture(page, [{ id: 'all', ...rect(0, 5, 18, 1, 'mint') }]); await drop(page, '#all', 0, 5); assert.equal((await blocks(page)).length, 0); passed.push('Fully consumed blocks and an empty board work');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(); watch(mobile); await fixture(mobile, middle); const cdp = await mobileContext.newCDPSession(mobile);
  const mobileField = await mobile.locator('#field').boundingBox(), mobileCell = mobileField.width / 18;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mobileField.x + mobileCell, y: mobileField.y + 4 * mobileCell, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mobileField.x + 9 * mobileCell, y: mobileField.y + 11 * mobileCell, id: 1 }] });
  assert.equal(await mobile.locator('#selection-box').isVisible(), true);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.deepEqual(await selected(mobile), ['large', 'left', 'right']);
  passed.push('Touch can draw a marquee and retain selection');
  const touch = async (selector, x, y, cancel = false) => {
    const { field, cube, block, cell } = await geometry(mobile, selector);
    const finger = { x: cube.x + cube.width * 0.3, y: cube.y + cube.height * 0.3, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: field.x + (x + block.width * 0.3) * cell, y: field.y + (y + block.height * 0.3) * cell, id: 1 }] });
    await nearest(mobile, selector, x, y);
    if (cancel) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    else await release(mobile, () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
  };
  await touch('#plug', 17, 7, true); assert.equal((await blocks(mobile)).length, 4); await touch('#plug', 17, 7);
  const part = (await blocks(mobile)).find(item => item.row === 8); await touch(`#${part.id}`, 0.7, 20.4);
  assert.equal((await blocks(mobile)).find(item => item.id === part.id).row, 20); assert.equal(await mobile.evaluate(() => scrollY), 0);
  for (const size of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) {
    await mobile.setViewportSize(size); for (const item of await blocks(mobile)) await geometry(mobile, `#${item.id}`);
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight));
  }
  passed.push('Real mobile touch clears lines and drags fragments; touch cancellation and responsive portrait/landscape sizes work');
  const offline = await context.newPage(); watch(offline); await offline.goto(new URL('../index.html', import.meta.url).href); assert.equal((await blocks(offline)).length, 29); await drop(offline, '#cube-gold', 7.4, 14.3); passed.push('Works from an offline HTML file');

  // Real demonstration from the unchanged 29-block layout.
  await page.unroute(`${url}/`); await page.goto(url); await drop(page, '#cube-lime', 0, 27); await startDrag(page, '#cube-blue', 6, 27);
  await page.locator('#field').screenshot({ path: new URL('line-clear-before.png', outputs).pathname }); await release(page);
  await page.waitForFunction(() => !document.querySelector('.line-clear')); await page.locator('#field').screenshot({ path: new URL('line-clear-after.png', outputs).pathname });
  assert.deepEqual(errors, []); const report = { passed, browser: await browser.version(), errors };
  await page.reload();
  await marquee(page, [0.5, 0.5], [12.5, 17.5]); await page.mouse.up();
  await page.locator('#field').screenshot({ path: new URL('marquee-selection.png', outputs).pathname });
  await writeFile(new URL('browser-report.json', outputs), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
