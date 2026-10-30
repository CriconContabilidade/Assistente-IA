import fs from 'fs';
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const buf = new Uint8Array(fs.readFileSync(process.argv[2]));
const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
let out = [];
let imgs = 0;
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  const ops = await page.getOperatorList();
  const ni = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length;
  imgs += ni;
  const linhas = new Map();
  for (const it of tc.items) { if (!it.str.trim()) continue; const y = Math.round(it.transform[5] / 3); const l = linhas.get(y) || []; l.push(it); linhas.set(y, l); }
  const txt = [...linhas.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l.sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(' ')).join('\n');
  out.push(`=== PÁGINA ${n} (imagens: ${ni}) ===\n${txt}`);
}
fs.writeFileSync(process.argv[3], out.join('\n\n'), 'utf8');
console.log('páginas:', doc.numPages, '| imagens:', imgs, '| chars:', out.join('').length);
