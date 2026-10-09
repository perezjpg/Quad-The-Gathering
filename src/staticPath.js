// Resuelve la ruta de un archivo estático dentro de `root`, igual en Windows y Linux/macOS.
// Devuelve null si la URL intenta salir de la carpeta (path traversal) o es inválida.

import nodePath from 'node:path';

export function staticPath(root, pathname, path = nodePath) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  // Decidir index.html con la URL original ("/"), antes de convertir separadores
  if (rel.endsWith('/') || rel.endsWith('\\')) rel += 'index.html';
  const base = path.resolve(root);
  const file = path.resolve(base, '.' + path.sep + rel.replace(/^[/\\]+/, ''));
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}
