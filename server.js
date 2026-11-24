'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Pool} = require('pg');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({connectionString:process.env.DATABASE_URL, max:5, ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
const token=()=>crypto.randomBytes(24).toString('base64url');
const shuffle=n=>{const a=Array.from({length:n},(_,i)=>i);for(let i=n-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a};
const derange=n=>{let a;do{a=shuffle(n)}while(a.some((v,i)=>v===i));return a};
const respond=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(obj))};
const ready=pool.query(`CREATE TABLE IF NOT EXISTS santa_games (id text PRIMARY KEY, title text NOT NULL, budget text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS santa_people (game_id text NOT NULL REFERENCES santa_games(id), name text NOT NULL, access_key text NOT NULL UNIQUE, recipient text NOT NULL, PRIMARY KEY(game_id,access_key));`);
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 try{
  await ready;
  if(req.method==='GET'&&u.pathname==='/health') return respond(res,200,{ok:true});
  if(req.method==='POST'&&u.pathname==='/api/create'){
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Object.assign(new Error('Слишком большой запрос'),{status:413})}
   let p;try{p=JSON.parse(raw)}catch{throw Object.assign(new Error('Неверный JSON'),{status:400})}
   const names=p.names;
   if(!Array.isArray(names)||names.length<3||names.length>100||names.some(n=>typeof n!=='string'||!n.trim()||n.length>70)||new Set(names.map(n=>n.trim().toLocaleLowerCase('ru'))).size!==names.length)throw Object.assign(new Error('Нужно 3–100 участников с уникальными именами'),{status:400});
   const id=token(),order=derange(names.length),people=names.map((name,i)=>({name:name.trim(),key:token(),recipient:names[order[i]].trim()}));
   const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO santa_games(id,title,budget) VALUES($1,$2,$3)',[id,String(p.title||'Тайный Санта').slice(0,100),String(p.budget||'').slice(0,100)]);for(const person of people)await client.query('INSERT INTO santa_people(game_id,name,access_key,recipient) VALUES($1,$2,$3,$4)',[id,person.name,person.key,person.recipient]);await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
   return respond(res,200,{id,links:people.map(x=>({name:x.name,url:`/gift/${id}/${x.key}`}))});
  }
  if(req.method==='GET'&&u.pathname.startsWith('/api/gift/')){
   const match=/^\/api\/gift\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
   if(!match)return respond(res,404,{error:'Ссылка не найдена'});
   const {rows}=await pool.query('SELECT g.title,g.budget,p.name,p.recipient FROM santa_people p JOIN santa_games g ON g.id=p.game_id WHERE p.game_id=$1 AND p.access_key=$2',[match[1],match[2]]);
   return rows.length?respond(res,200,rows[0]):respond(res,404,{error:'Ссылка не найдена'});
  }
  if(req.method==='GET'&&(u.pathname==='/'||/^\/gift\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(u.pathname))){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});return fs.createReadStream(path.join(__dirname,'public','index.html')).pipe(res)}
  return respond(res,404,{error:'Не найдено'});
 }catch(e){console.error('Request failed:',e.message);return respond(res,e.status||500,{error:e.status?e.message:'Ошибка сервера. Попробуйте позже.'})}
});
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Santa listening'));
