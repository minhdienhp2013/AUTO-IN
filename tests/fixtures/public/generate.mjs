// Public synthetic assets; NO customer data, NO printer side-effects.
import {Buffer} from 'node:buffer';
import {deflateRawSync,deflateSync} from 'node:zlib';
import {crc32} from './zip-crc.mjs';
const le16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const le32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
const be32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n>>>0);return b;};
export function syntheticPdf(){
 const parts=['%PDF-1.4\n'],offsets=[];
 function add(n,s){offsets[n]=Buffer.byteLength(parts.join(''),'latin1');parts.push(n+' 0 obj\n'+s+'\nendobj\n');}
 add(1,'<< /Type /Catalog /Pages 2 0 R >>');
 add(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
 add(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
 add(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 const stream='BT /F1 12 Tf 50 790 Td (SYNTHETIC TEST ONLY) Tj ET\n';
 add(5,'<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream');
 const pointer=Buffer.byteLength(parts.join(''),'latin1');
 parts.push('xref\n0 6\n0000000000 65535 f \n');
 for(let i=1;i<=5;i++)parts.push(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
 parts.push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+pointer+'\n%%EOF\n');
 return Buffer.from(parts.join(''),'latin1');
}
function chunk(name,data){
 const type=Buffer.from(name);
 return Buffer.concat([be32(data.length),type,data,be32(crc32(Buffer.concat([type,data])))]);
}
export function syntheticPng(){
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),
 chunk('IHDR',Buffer.concat([be32(1),be32(1),Buffer.from([8,2,0,0,0])])),
 chunk('IDAT',deflateSync(Buffer.from([0,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}
export function syntheticZip(entries){
 const local=[],central=[];let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name),raw=Buffer.from(entry.content),data=deflateRawSync(raw),crc=crc32(raw);
  const head=Buffer.concat([le32(0x04034b50),le16(20),le16(0),le16(8),le16(0),le16(0),le32(crc),le32(data.length),le32(raw.length),le16(name.length),le16(0),name]);
  local.push(head,data);
  central.push(Buffer.concat([le32(0x02014b50),le16(20),le16(20),le16(0),le16(8),le16(0),le16(0),le32(crc),le32(data.length),le32(raw.length),le16(name.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),name]));
  offset+=head.length+data.length;
 }
 const cd=Buffer.concat(central);
 return Buffer.concat([...local,cd,le32(0x06054b50),le16(0),le16(0),le16(entries.length),le16(entries.length),le32(cd.length),le32(offset),le16(0)]);
}
export function makeAssets(){
 return {
  'tai-lieu-mau-an-toan.pdf':syntheticPdf(),
  'anh-mau-an-toan.png':syntheticPng(),
  'hop-le-2-file.zip':syntheticZip([{name:'page.pdf',content:syntheticPdf()},{name:'image.png',content:syntheticPng()}]),
  'nguy-hiem-path-traversal.zip':syntheticZip([{name:'../../escape.txt',content:'DO NOT EXTRACT'}]),
  'nguy-hiem-zip-bomb-ratio.zip':syntheticZip([{name:'big.txt',content:'x'.repeat(400000)}]),
  'nguy-hiem-qua-5-tai-lieu.zip':syntheticZip(Array.from({length:6},(_,i)=>({name:'doc'+i+'.pdf',content:syntheticPdf()}))),
  'nguy-hiem-file-loi.zip':Buffer.from('THIS IS NOT A ZIP'),
  'nguy-hiem-pdf-khong-hop-le.pdf':Buffer.from('%PDF-1.4\ntruncated synthetic')
 };
}
if(process.argv.includes('--output')){
 const {mkdir,writeFile}=await import('node:fs/promises'),{resolve}=await import('node:path');
 const dir=resolve(process.argv[process.argv.indexOf('--output')+1]);
 await mkdir(dir,{recursive:true});
 for(const [name,data] of Object.entries(makeAssets()))await writeFile(resolve(dir,name),data);
 console.log('SYNTHETIC_ONLY: wrote 8 fixtures to '+dir);
}
