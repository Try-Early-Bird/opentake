// Renders the macOS app icon: the Earlybird mark on a black rounded square (Apple's 1024 grid:
// an 824 px tile with 100 px margins). Usage: node scripts/render-app-icon.cjs . icon-1024.png,
// then build the iconset with sips and iconutil (build/icon.icns) and a 512 px build/icon.png.
const {createCanvas,Path2D}=require(process.argv[2]+'/node_modules/@napi-rs/canvas');
const src=require('fs').readFileSync(process.argv[2]+'/src/renderer/src/logos.tsx','utf8');
const d=/EarlybirdMark[\s\S]*?\bd="([^"]+)"/.exec(src)[1];
const size=1024,tile=824,margin=(size-tile)/2,radius=185;
const c=createCanvas(size,size),g=c.getContext('2d');
g.beginPath();g.roundRect(margin,margin,tile,tile,radius);g.fillStyle='#000000';g.fill();
// Measure the mark's bounds so it is centred optically, not by its viewBox.
const probe=createCanvas(700,700),pg=probe.getContext('2d');pg.translate(43,0);pg.fillStyle='#fff';pg.fill(new Path2D(d));
const data=pg.getImageData(0,0,700,700).data;let x0=700,y0=700,x1=0,y1=0;
for(let y=0;y<700;y++)for(let x=0;x<700;x++)if(data[(y*700+x)*4+3]>8){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
const w=x1-x0+1,h=y1-y0+1,target=tile*0.62,scale=target/Math.max(w,h);
g.save();g.translate(size/2-(x0+w/2)*scale,size/2-(y0+h/2)*scale);g.scale(scale,scale);g.translate(43,0);g.fillStyle='#32D15A';g.fill(new Path2D(d));g.restore();
require('fs').writeFileSync(process.argv[3],c.toBuffer('image/png'));
console.log('mark bounds',{x0,y0,w,h},'scale',scale.toFixed(3));
