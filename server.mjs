import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import aiHandler from './api/ai.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8'};
function loadEnv(){for(const file of ['.env.local','.env']){try{const text=readFileSync(join(root,file),'utf8');for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*([^#=]+)=(.*)$/);if(m&&!process.env[m[1].trim()])process.env[m[1].trim()]=m[2].trim().replace(/^['"]|['"]$/g,'')}}catch{}}}
loadEnv();
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/api/ai')){let raw='';for await(const chunk of req)raw+=chunk;req.body=raw;return aiHandler(req,res)}
  try{const pathname=decodeURIComponent((req.url||'/').split('?')[0]);const safe=normalize(join(root,pathname==='/'?'index.html':pathname.slice(1)));if(!safe.startsWith(root))throw new Error('forbidden');const info=await stat(safe);if(!info.isFile())throw new Error('not found');res.setHeader('Content-Type',mime[extname(safe)]||'application/octet-stream');let body=await readFile(safe);if(pathname==='/'||pathname==='/index.html'){const config=`<script>window.RR_SUPABASE_URL=${JSON.stringify(process.env.SUPABASE_URL||'')};window.RR_SUPABASE_ANON_KEY=${JSON.stringify(process.env.SUPABASE_ANON_KEY||'')};</script>`;body=Buffer.from(body.toString('utf8').replace('</head>',`${config}</head>`))}res.end(body)}catch{res.statusCode=404;res.end('Not found')}});
server.listen(port,()=>console.log(`IPS R&R server: http://127.0.0.1:${port}`));
