'use strict';
// The launcher's small markdown renderer (html/launcher.html: esc, mdInline, md) renders Claude's
// replies, which may echo text from any file or web page — so it must never emit live markup.
// The functions are lifted out of the page and run in a sandbox.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'html', 'launcher.html'), 'utf8');
function lift(name, until) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in launcher.html');
  const end = html.indexOf(until, start + 1);
  return html.slice(start, end);
}
const ctx = { PANES: { a: { cwd: '/workspace/proj' } }, ACTIVE: 'a' };
vm.createContext(ctx);
vm.runInContext([
  html.slice(html.indexOf('function esc('), html.indexOf('\n', html.indexOf('function esc('))),
  html.slice(html.indexOf('var IMG_EXT='), html.indexOf('function mdInline(')),
  lift('mdInline', '\nfunction md('),
  lift('md', '\n// ====='),
].join('\n'), ctx);
const { mdInline, md } = ctx;

// every tag in the output must be one the renderer is allowed to emit, with no extra attributes
const TAG = /<\/?([a-z0-9]+)([^>]*)>/gi;
const ALLOWED = new Set(['a', 'img', 'code', 'strong', 'em', 'pre', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'tr', 'th', 'td',
  'blockquote', 'ul', 'ol', 'li', 'p', 'br']);
function assertSafe(out, input) {
  // quoted attribute values are dropped first, so a '>' inside an href can't hide a tag
  const bare = out.replace(/"[^"]*"/g, '""');
  assert.ok(!/<(?:script|svg|iframe|style)\b/i.test(bare), 'dangerous tag for ' + input + ':\n' + out);
  let m;
  while ((m = TAG.exec(bare))) {
    assert.ok(ALLOWED.has(m[1].toLowerCase()), 'unexpected <' + m[1] + '> for ' + input + ':\n' + out);
    const attrs = m[2].trim();
    if (m[1].toLowerCase() === 'a' && !m[0].startsWith('</')) {
      // links; image links (class="mdimg") and image-path code links also carry a title
      assert.ok(['href="" target="" rel=""', 'href="" target="" rel="" title=""', 'class="" href="" target="" rel="" title=""'].includes(attrs),
        'extra attributes on <a> for ' + input + ':\n' + out);
    } else if (m[1].toLowerCase() === 'img') {
      assert.strictEqual(attrs, 'src="" alt="" loading=""', 'attributes on <img> for ' + input + ':\n' + out);
    } else {
      assert.ok(attrs === '' || attrs === '/', 'attributes on <' + m[1] + '> for ' + input + ':\n' + out);
    }
  }
  // the href value itself: always http(s), never broken out of
  for (const h of out.matchAll(/<a (?:class="mdimg" )?href="([^"]*)"/g)) assert.match(h[1], /^(https?:\/\/|workspace\/image\?p=|data:image\/)/);
  for (const h of out.matchAll(/<img src="([^"]*)"/g)) assert.match(h[1], /^(https?:\/\/|workspace\/image\?p=|data:image\/)/);
}

const PAYLOADS = [
  // the one that used to work: the bare-URL pass re-scanned the href built by the link pass
  "[t](https://x(https://y/onmouseover=location='javascript:alert\\x281\\x29'//)",
  '[t](https://x(https://y/" onmouseover="alert(1))',
  '[a](https://x(https://y/onfocus=alert`1`/autofocus)',
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '[x](https://ok.example/"><img src=x onerror=alert(1)>)',
  'see https://a.example/"onmouseover="alert(1) now',
  '(https://a.example/<svg/onload=alert(1)>)',
  '**[b](https://a.example/**onclick=alert(1)//)**',
  '`code` [l](https://a.example/`x`) https://b.example/\u0000 \u00000\u0000',
  '[`code`](https://a.example/)',
  '*https://a.example/*onmouseover=alert(1)*',
  '![x](javascript:alert(1))',
  '![x" onerror="alert(1)](/tmp/a.png)',
  '![x](/tmp/a.png" onerror="alert(1))',
  '![x](data:text/html,<script>alert(1)</script>)',
  '`/tmp/a"onerror=alert(1).png`',
];

test('pictures: markdown images and image paths in code', () => {
  assert.match(mdInline('![s](/tmp/x.png)'), /<img src="workspace\/image\?p=%2Ftmp%2Fx\.png"/);
  assert.match(mdInline('![s](shots/a.jpg)'), /p=%2Fworkspace%2Fproj%2Fshots%2Fa\.jpg/);
  assert.match(mdInline('![s](https://e.example/a.png)'), /<img src="https:\/\/e\.example\/a\.png"/);
  assert.match(mdInline('saved `/tmp/s.png`'), /<a href="workspace\/image\?p=%2Ftmp%2Fs\.png"[^>]*><code>/);
  assert.doesNotMatch(mdInline('`/tmp/notes.txt`'), /<a /);
});

test('XSS payloads render as inert text', () => {
  for (const p of PAYLOADS) {
    assertSafe(mdInline(p), p);
    assertSafe(md(p), p);
    assertSafe(md('# ' + p + '\n\n- ' + p + '\n\n> ' + p + '\n\n| a |\n|---|\n| ' + p + ' |'), p);
  }
});

test('the old breakout produces exactly one link and keeps the payload as text', () => {
  const out = mdInline("[t](https://x(https://y/onmouseover=location='javascript:alert\\x281\\x29'//)");
  assert.strictEqual((out.match(/<a /g) || []).length, 1, out);
  // outside quoted attribute values there is no handler (inside the href it is just URL text)
  assert.ok(!/onmouseover/.test(out.replace(/"[^"]*"/g, '""')), out);
});

test('ordinary markdown still renders', () => {
  assert.strictEqual(mdInline('**bold** and *it*'), '<strong>bold</strong> and <em>it</em>');
  assert.strictEqual(mdInline('use `a<b>`'), 'use <code>a&lt;b&gt;</code>');
  assert.strictEqual(mdInline('[docs](https://example.com/a?b=1&c=2)'),
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">docs</a>');
  assert.strictEqual(mdInline('see https://example.com/x.'),
    'see <a href="https://example.com/x." target="_blank" rel="noopener">https://example.com/x.</a>');
  assert.strictEqual(mdInline('(https://example.com)'),
    '(<a href="https://example.com" target="_blank" rel="noopener">https://example.com</a>)');
  assert.strictEqual(mdInline('**see [it](https://example.com)**'),
    '<strong>see <a href="https://example.com" target="_blank" rel="noopener">it</a></strong>');
  assert.strictEqual(mdInline('[`cmd`](https://example.com)'),
    '<a href="https://example.com" target="_blank" rel="noopener"><code>cmd</code></a>');
  assert.strictEqual(mdInline('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});
