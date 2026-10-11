// CRC32 for synthetic ZIP and PNG fixtures only.
let t;
export function crc32(bytes){
 t??=Array.from({length:256},(_,i)=>{let x=i;for(let k=0;k<8;k++)x=(x&1)?(0xedb88320^(x>>>1)):(x>>>1);return x>>>0;});
 let c=0xffffffff;for(const b of bytes)c=t[(c^b)&255]^(c>>>8);
 return (c^0xffffffff)>>>0;
}
