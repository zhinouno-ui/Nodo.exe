// Build dual:
//  - En Vercel (env VERCEL=1): publica SOLO la landing web en public/ (no compila Electron).
//  - En local: compila la app de escritorio con electron-builder, como siempre.
// Esto destraba el deploy de Vercel sin romper el flujo de compilación de la app.
const fs = require('fs');
const path = require('path');

if (process.env.VERCEL || process.env.NOW_BUILDER) {
  const out = path.join(__dirname, 'public');
  fs.mkdirSync(out, { recursive: true });
  // Solo los HTML de la landing van a la web. El panel operador (.htm) y los preload NO.
  ['index.html', 'app.js', 'landing.html'].forEach(function (f) {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(out, f));
      console.log('Vercel build: copiado', f, '-> public/');
    }
  });
  console.log('Vercel build OK: landing publicada en public/');
} else {
  const { execSync } = require('child_process');
  console.log('Build local: compilando app Electron con electron-builder...');
  execSync('electron-builder', { stdio: 'inherit' });
}
