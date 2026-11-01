// Build: inline CSS, DSP sources and UI scripts into one HTML file.
//   dist/index.html     full standalone document (open locally or host anywhere)
//   dist/artifact.html  body fragment for hosts that add their own <html>/<head> skeleton
// Usage: node tools/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const fxFiles = fs.readdirSync(path.join(root, 'src/dsp')).filter((f) => /^fx-.*\.js$/.test(f)).sort();
const dspOrder = ['lib.js', 'params.js', 'units.js', ...fxFiles, 'time-engines.js', 'core.js'];
const dsp = dspOrder.map((f) => `// ---- ${f}\n` + rd('src/dsp/' + f)).join('\n');
const uiFiles = fs.readdirSync(path.join(root, 'src/ui')).filter((f) => f.endsWith('.js')).sort();
const ui = uiFiles.map((f) => `// ---- ${f}\n` + rd('src/ui/' + f)).join('\n');
if (/<\/script|<!--/i.test(dsp + ui)) throw new Error('inline source contains </script or <!--');

let frag = rd('src/index.html');
frag = frag.replace('/*__STYLE__*/', () => rd('src/style.css'));
frag = frag.replace('/*__DSP__*/', () => dsp);
frag = frag.replace('/*__APP__*/', () => ui);

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${frag}
</body>
</html>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), full);
fs.writeFileSync(path.join(root, 'dist/artifact.html'), frag);
console.log(`dist/index.html ${(full.length / 1024).toFixed(0)} KB · fx banks: ${fxFiles.join(', ') || 'none'}`);
