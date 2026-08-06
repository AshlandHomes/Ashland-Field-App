/*
 * Browser proof of the ADMIN dependents UI, driving the REAL functions inside
 * admin-dev.html (no copies). We stub the network so no Supabase is hit, seed
 * tplEdit.tasks with the real Slab fixture (synthesizing an `id` per task the
 * way Supabase would supply one), then invoke the real openEditTaskModal /
 * openDependentsModal and read back the DOM the page actually renders.
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/template_tasks.json'), 'utf8'))
    .map(t => ({ ...t, id: 'id-' + t.bt_num }));   // Supabase-shaped id
  const fileUrl = 'file://' + path.resolve(__dirname, '..', 'admin-dev.html');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  // Block every network call the page's init tries to make (Supabase etc.).
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file://')) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

  // Confirm the real functions + module are present.
  const present = await page.evaluate(() => ({
    engine: typeof ScheduleEngine !== 'undefined' && typeof ScheduleEngine.computeSuccessors === 'function',
    openDep: typeof openDependentsModal === 'function',
    openEdit: typeof openEditTaskModal === 'function',
    depJump: typeof depJumpTo === 'function',
  }));
  console.log('functions present:', JSON.stringify(present));

  // Seed the real editor state and open #71 the way a user would.
  const result = await page.evaluate((seed) => {
    // tplEdit is a top-level `let` (lexical global, not a window property) — mutate it in place.
    tplEdit.id = 'tpl-slab'; tplEdit.tasks = seed;
    // Open the editor for #71 Drywall Installation via its synthesized id.
    openEditTaskModal('id-71');
    const depBtnLabel = document.getElementById('task-dep-btn').textContent;
    const depBtnShown = document.getElementById('task-dep-btn').style.display !== 'none';
    // Now open the dependents modal (real function).
    openDependentsModal();
    const modalOpen = document.getElementById('modal-dependents').classList.contains('open');
    const title = document.getElementById('dep-title').textContent;
    const rows = Array.from(document.querySelectorAll('#dep-list > div')).map(d => d.innerText.replace(/\s+/g, ' ').trim());
    // Prove a row click jumps to that task's editor.
    const firstRow = document.querySelector('#dep-list > div');
    firstRow && firstRow.click();
    const jumpedBt = document.getElementById('task-btnum').value;
    const depModalClosedAfterJump = !document.getElementById('modal-dependents').classList.contains('open');
    return { depBtnLabel, depBtnShown, modalOpen, title, rows, jumpedBt, depModalClosedAfterJump };
  }, tasks);

  // Positive-lag case: open #101 (Final Grade), whose successor #118 Landscaping is +6.
  const posRows = await page.evaluate(() => {
    tplEdit.tasks = tplEdit.tasks;  // already seeded
    openEditTaskModal('id-101');
    openDependentsModal();
    return Array.from(document.querySelectorAll('#dep-list > div')).map(d => d.innerText.replace(/\s+/g, ' ').trim());
  });
  console.log('\n#101 dependents (positive-lag case):');
  posRows.forEach(r => console.log('   • ' + r));

  const G='\x1b[32m',Rr='\x1b[31m',Xx='\x1b[0m',ok=b=>b?G+'PASS'+Xx:Rr+'FAIL'+Xx;
  console.log('\n===== ADMIN DEPENDENTS UI (real admin-dev.html, real Slab data) =====\n');
  console.log('dep button label :', result.depBtnLabel, '(shown:', result.depBtnShown + ')');
  console.log('modal title      :', result.title);
  console.log('modal rows:');
  result.rows.forEach(r => console.log('   • ' + r));

  let pass = true;
  const check = (label, cond) => { pass = pass && cond; console.log('   [' + ok(cond) + '] ' + label); };
  console.log('');
  check('all functions + engine present', present.engine && present.openDep && present.openEdit && present.depJump);
  check('no page errors ('+errors.length+')', errors.length === 0);
  check('dep button shows count (4)', /\(4\)/.test(result.depBtnLabel) && result.depBtnShown);
  check('modal opened', result.modalOpen);
  check('title names #71 with count 4', /#71/.test(result.title) && /\(4\)/.test(result.title));
  check('4 dependent rows rendered', result.rows.length === 4);
  check('negative-lag label present', result.rows.some(r => /Lead time · 9 days before this task starts/.test(r)));
  check('zero-lag label present', result.rows.some(r => /Right after this finishes/.test(r)));
  check('positive-lag label present (#101→#118 +6)', posRows.some(r => /6 days after this finishes/.test(r) && /#118/.test(r)));
  check('row click jumped editor to a dependent (#69/75/76/77)', ['69','75','76','77'].includes(result.jumpedBt));
  check('dependents modal closed after jump', result.depModalClosedAfterJump);

  if (errors.length) { console.log('\nPAGE ERRORS:'); errors.forEach(e => console.log('  ' + e)); }
  console.log('\n===== ' + (pass ? G+'ALL PASS' : Rr+'FAIL') + Xx + ' =====');
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
