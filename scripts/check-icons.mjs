import {readdir,readFile} from 'node:fs/promises';
import {extname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const excluded=new Set(['node_modules','target','dist','.git','test_snapshots']);
const extensions=new Set(['.js','.jsx','.mjs','.ts','.tsx','.css','.html','.rs','.md','.json','.toml','.yml','.yaml']);
const emoji=/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u20E3]/u;
const findings=[];
let checked=0;
async function scan(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(excluded.has(entry.name))continue;
    const file=join(directory,entry.name);
    if(entry.isDirectory()){await scan(file);continue;}
    if(!extensions.has(extname(file)))continue;
    checked++;
    (await readFile(file,'utf8')).split(/\r?\n/).forEach((line,index)=>{
      if(emoji.test(line))findings.push(`${relative(root,file)}:${index+1}`);
    });
  }
}
await scan(root);
if(findings.length){console.error('Emoji characters are not allowed. Use the shared SVG icon component:\n'+findings.join('\n'));process.exitCode=1;}
else console.log(`No emojis found in ${checked} authored code/config/documentation files.`);
