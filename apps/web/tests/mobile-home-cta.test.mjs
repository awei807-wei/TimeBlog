import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('home exposes an authenticated mobile writing button with active session revalidation', async () => {
  const source = await fs.readFile(new URL('../app/HomeTimeline.tsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/public-shell.css', import.meta.url), 'utf8');
  const dialog = await fs.readFile(new URL('../app/admin/QuickWriteDialog.tsx', import.meta.url), 'utf8').catch(() => '');

  assert.match(source, /useSession/);
  assert.match(source, /if \(state === 'loading'\) return null/);
  assert.match(source, /refreshSession/);
  assert.match(source, /await refreshSession\(\)/);
  assert.match(source, /router\.push\('\/login'\)/);
  assert.match(source, /<button[\s\S]*className="public-mobile-fab"/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /aria-expanded=\{quickWriteOpen\}/);
  assert.match(source, /aria-busy=\{sessionChecking\}/);
  assert.match(source, /const Icon = authenticated \? PenLine : LogIn/);
  assert.match(source, /const quickWriteFabRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(source, /ref=\{quickWriteFabRef\}/);
  assert.match(source, /returnFocusRef=\{quickWriteFabRef\}/);
  assert.match(source, /className="public-mobile-fab"/);
  assert.match(source, /dynamic\(\(\) => import\('\.\/admin\/QuickWriteDialog'\)/);
  assert.match(dialog, /useAdminPageController\(\{ editEntryID: null, active: open \}\)/);
  assert.match(dialog, /Dialog\.Content/);
  assert.match(dialog, /Dialog\.Title/);
  assert.match(dialog, /Dialog\.Description/);
  assert.match(dialog, /editorPortalElement/);
  assert.match(dialog, /onCloseAutoFocus=\{event => \{[\s\S]*event\.preventDefault\(\)[\s\S]*returnFocusRef\?\.current\?\.focus\(\)/);
  assert.match(dialog, /persistNow/);
  assert.match(dialog, /mediaStillProcessing/);

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

test('quick writing dialog keeps one scroll surface above the public mobile chrome', async () => {
  const dialog = await fs.readFile(new URL('../app/admin/QuickWriteDialog.tsx', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../app/admin/AdminEditorView.tsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../app/public-shell.css', import.meta.url), 'utf8');
  const persistence = await fs.readFile(new URL('../app/admin/useDraftPersistence.ts', import.meta.url), 'utf8');

  assert.match(dialog, /const controller = useAdminPageController\(\{ editEntryID: null, active: open \}\);[\s\S]*<Dialog\.Root[\s\S]*<Dialog\.Content/);
  assert.match(persistence, /if \(!active\) return undefined/);
  assert.match(dialog, /presentation="dialog"/);
  assert.match(dialog, /onOpenChange/);
  assert.match(dialog, /persistNow/);
  assert.match(dialog, /上传中|保存中/);
  assert.match(view, /props\.presentation === 'dialog'/);
  assert.match(view, /props\.presentation !== 'dialog'/);
  assert.match(view, /writing-page-header\$\{props\.presentation === 'dialog' \? ' is-dialog' : ''\}/);
  assert.match(view, /return <main id="main-content"/);
  assert.match(css, /\.quick-write-dialog-overlay[\s\S]*z-index:\s*100/);
  assert.match(css, /\.quick-write-dialog-content[\s\S]*z-index:\s*101/);
  assert.match(css, /\.quick-write-dialog-scroll[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /safe-area-inset-(top|bottom)/);
  assert.match(css, /100dvh/);
  assert.match(css, /min-width:\s*44px[\s\S]*min-height:\s*44px/);
});
