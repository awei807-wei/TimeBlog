import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('home exposes an authenticated mobile writing or login action', async () => {
  const source = await fs.readFile(new URL('../app/HomeTimeline.tsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/public-shell.css', import.meta.url), 'utf8');

  assert.match(source, /useSession/);
  assert.match(source, /if \(state === 'loading'\) return null/);
  assert.match(source, /href=\{authenticated \? '\/admin' : '\/login'\}/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /const Icon = authenticated \? PenLine : LogIn/);
  assert.match(source, /className="public-mobile-fab"/);

  const mobileRules = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(css, /\.public-mobile-fab \{\s*display: none;/);
  assert.match(mobileRules, /\.public-masthead \{[\s\S]*backdrop-filter: none;/);
  assert.match(mobileRules, /\.public-mobile-fab \{[\s\S]*position: fixed;/);
  assert.match(mobileRules, /bottom: calc\(50px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.doesNotMatch(mobileRules, /bottom: calc\(58px \+ 50px/);
  assert.match(mobileRules, /width: 52px;[\s\S]*height: 52px;/);
  assert.match(mobileRules, /background: #000;[\s\S]*color: #fff;/);
  assert.match(mobileRules, /\.public-mobile-fab:focus-visible[\s\S]*outline: 3px solid/);
});
