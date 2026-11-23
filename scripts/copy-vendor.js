// Copies browser libraries from node_modules into public/vendor so the app
// works fully offline / on a LAN with no CDN dependency.
// (QR codes are rendered server-side via GET /qr — no client lib needed.)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

const files = [['hls.js', 'dist/hls.min.js', 'hls.min.js']];

for (const [pkg, sub, out] of files) {
  const src = path.join(root, 'node_modules', pkg, sub);
  const dst = path.join(vendor, out);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log('vendored', out);
  } else {
    console.warn('MISSING vendor source:', src);
  }
}
