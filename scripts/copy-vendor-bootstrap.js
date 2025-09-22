const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', 'node_modules', 'bootstrap', 'dist', 'js', 'bootstrap.bundle.min.js');
const destDir = path.resolve(__dirname, '..', 'public', 'vendor');
const dest = path.join(destDir, 'bootstrap.bundle.min.js');

try {
  if (!fs.existsSync(src)) {
    console.warn('[copy-vendor-bootstrap] source not found:', src);
    process.exit(0);
  }
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[copy-vendor-bootstrap] copied bootstrap.bundle.min.js to public/vendor');
} catch (err) {
  console.error('[copy-vendor-bootstrap] failed', err);
  process.exit(1);
}
