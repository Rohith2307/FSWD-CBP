const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_ALLOW_LIST } = require('../src/routes/static');

test('ui-wiring: HTML IDs, script, and link consistency verification', async (t) => {
  const publicDir = path.resolve(__dirname, '..', 'public');
  const appJsPath = path.join(publicDir, 'app.js');
  const indexHtmlPath = path.join(publicDir, 'index.html');

  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  await t.test('all element IDs queried by app.js exist exactly once in index.html', () => {
    // Extract IDs used in app.js
    const idRegexes = [
      /getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
      /querySelector\(\s*['"`]#([a-zA-Z0-9_-]+)['"`]\s*\)/g,
      /querySelectorAll\(\s*['"`]#([a-zA-Z0-9_-]+)['"`]\s*\)/g
    ];

    const usedIds = new Set();
    for (const re of idRegexes) {
      let m;
      while ((m = re.exec(appJs)) !== null) {
        usedIds.add(m[1]);
      }
    }

    // Extract all id="..." attributes in index.html
    const htmlIdRegex = /\bid\s*=\s*['"`]([^'"`]+)['"`]/g;
    const htmlIdCounts = new Map();
    let m;
    while ((m = htmlIdRegex.exec(indexHtml)) !== null) {
      const id = m[1];
      htmlIdCounts.set(id, (htmlIdCounts.get(id) || 0) + 1);
    }

    // Assert each id in index.html exists exactly once
    for (const [id, count] of htmlIdCounts) {
      assert.equal(count, 1, `ID "${id}" in index.html appears ${count} times (must be exactly 1)`);
    }

    // Assert each queried ID exists in index.html
    const missingInHtml = [];
    for (const id of usedIds) {
      if (!htmlIdCounts.has(id)) {
        missingInHtml.push(id);
      }
    }
    assert.deepEqual(missingInHtml, [], `The following IDs are used in app.js but missing in index.html: ${missingInHtml.join(', ')}`);

    // Non-failing informative log of IDs in index.html not directly queried by app.js
    const unusedInApp = [];
    for (const [id] of htmlIdCounts) {
      if (!usedIds.has(id)) {
        unusedInApp.push(id);
      }
    }
    console.log(`[ui-wiring info] IDs in index.html not queried directly by app.js (${unusedInApp.length}):`, unusedInApp);
  });

  await t.test('every script src and link href in index.html is in static allow-list and exists', () => {
    // Extract script src
    const scriptSrcRegex = /<script\b[^>]*\bsrc\s*=\s*['"`]([^'"`]+)['"`][^>]*>/gi;
    const scriptSources = [];
    let sm;
    while ((sm = scriptSrcRegex.exec(indexHtml)) !== null) {
      scriptSources.push(sm[1]);
    }

    // Extract link href
    const linkHrefRegex = /<link\b[^>]*\bhref\s*=\s*['"`]([^'"`]+)['"`][^>]*>/gi;
    const linkHrefs = [];
    let lm;
    while ((lm = linkHrefRegex.exec(indexHtml)) !== null) {
      linkHrefs.push(lm[1]);
    }

    const allReferences = [...scriptSources, ...linkHrefs];
    assert.ok(allReferences.length > 0, 'index.html should have script and link references');

    for (const ref of allReferences) {
      const urlPath = ref.startsWith('/') ? ref : `/${ref}`;
      assert.ok(
        STATIC_ALLOW_LIST[urlPath],
        `Reference "${ref}" must be registered in STATIC_ALLOW_LIST`
      );

      const item = STATIC_ALLOW_LIST[urlPath];
      if (item.file) {
        const diskPath = path.join(publicDir, item.file);
        assert.ok(fs.existsSync(diskPath), `Referenced file "${diskPath}" must exist on disk`);
      }
    }
  });
});
