import test from 'node:test';
import assert from 'node:assert/strict';
import {makeAssets,syntheticPdf,syntheticPng} from '../fixtures/public/generate.mjs';
import {crc32} from '../fixtures/public/zip-crc.mjs';
test('FIXTURE ONLY: one-page A4 PDF has a consistent xref offset',()=>{
 const pdf=syntheticPdf().toString('latin1');
 assert.match(pdf,/\/Count 1/);
 assert.match(pdf,/\/MediaBox \[0 0 595 842\]/);
 const x=pdf.match(/startxref\n(\d+)\n%%EOF/);assert.ok(x);
 assert.ok(pdf.slice(Number(x[1])).startsWith('xref\n'));
});
test('FIXTURE ONLY: 1x1 RGB PNG checksum is valid',()=>{
 const buf=syntheticPng();assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(buf.readUInt32BE(16),1);assert.equal(buf.readUInt32BE(20),1);
 let p=8;while(p<buf.length){
  const n=buf.readUInt32BE(p),payload=buf.subarray(p+4,p+8+n);
  assert.equal(buf.readUInt32BE(p+8+n),crc32(payload));p+=12+n;
 }
 assert.equal(p,buf.length);
});
test('FIXTURE ONLY: 8 safe/dangerous assets are distinguishable',()=>{
 const a=makeAssets();assert.equal(Object.keys(a).length,8);
 assert.equal(a['tai-lieu-mau-an-toan.pdf'].subarray(0,4).toString(),'%PDF');
 assert.ok(a['nguy-hiem-path-traversal.zip'].includes(Buffer.from('../../escape.txt')));
 assert.ok(a['nguy-hiem-zip-bomb-ratio.zip'].readUInt32LE(22)>=400000);
 const z=a['nguy-hiem-qua-5-tai-lieu.zip'];
 assert.equal(z.readUInt16LE(z.length-12),6);
 assert.equal(a['nguy-hiem-file-loi.zip'].toString(),'THIS IS NOT A ZIP');
});
