import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { staticPath } from '../src/staticPath.js';

test('Windows: "/" sirve index.html (antes daba 404)', () => {
  const root = 'C:\\Users\\perez\\Quad-The-Gathering\\public';
  assert.equal(staticPath(root, '/', path.win32), `${root}\\index.html`);
  assert.equal(staticPath(root, '/lib/engine.js', path.win32), `${root}\\lib\\engine.js`);
  assert.equal(staticPath(root, '/styles.css', path.win32), `${root}\\styles.css`);
});

test('Linux/macOS/Termux: rutas normales', () => {
  const root = '/home/u/quad/public';
  assert.equal(staticPath(root, '/', path.posix), '/home/u/quad/public/index.html');
  assert.equal(staticPath(root, '/app.js', path.posix), '/home/u/quad/public/app.js');
});

test('bloquea path traversal en ambos sistemas', () => {
  assert.equal(staticPath('/srv/public', '/../server.js', path.posix), null);
  assert.equal(staticPath('/srv/public', '/%2e%2e/%2e%2e/etc/passwd', path.posix), null);
  assert.equal(staticPath('C:\\srv\\public', '/..\\..\\Windows\\win.ini', path.win32), null);
  assert.equal(staticPath('C:\\srv\\public', '/%E0%A4%A', path.win32), null);
});
