import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dependencyRoot = fileURLToPath(new URL('./fixtures/development-frameworks/', import.meta.url));
export const dependencies = path.join(dependencyRoot, 'node_modules');
const style = `*{box-sizing:border-box}body{margin:0;background:#f2f3ee;color:#263a32;font:16px/1.6 system-ui}main{max-width:1060px;margin:auto;padding:64px 28px}.eyebrow{font-size:12px;letter-spacing:.14em;color:#647b6e}h1{font-size:42px;font-weight:600;line-height:1.25;margin:12px 0 20px}.description{color:#5f7268;max-width:650px}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:30px 0}.marker{padding:7px 11px;background:#e0e9de;border-radius:7px;font:12px ui-monospace}button{padding:10px 16px;border:1px solid #ced8cd;background:white;color:inherit;border-radius:8px;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{background:#fff;border:1px solid #dce2d7;border-radius:14px;padding:22px}.card small{color:#718274}.card h2{font-size:20px;margin:14px 0}.footer{margin-top:38px;color:#708076;font-size:13px}@media(max-width:700px){main{padding:32px 20px}h1{font-size:32px}.grid{grid-template-columns:1fr}}`;
const body = `const [count,setCount]=useState(0);const [open,setOpen]=useState(false);return <main><span className="eyebrow">TEAMSWARM / PROJECT PREVIEW</span><h1>前端交接工作台</h1><p className="description">当前页面来自 {state.owner} 的独立工作副本。任务卡片和界面交互由实际开发服务器编译，源码修改后继续热更新。</p><div className="toolbar"><span className="marker">{state.marker}</span><button onClick={()=>setCount(count+1)}>交互检查 · {count}</button><button onClick={()=>setOpen(!open)}>{open?'显示全部任务':'只看进行中'}</button></div><div className="grid">{state.tasks.filter(t=>!open||t.status==='进行中').map(t=><article className="card" key={t.id}><small>{t.status}</small><h2>{t.title}</h2><p>{t.detail}</p></article>)}</div><p className="footer">开发框架 · ${'FRAMEWORK'}　/　工作副本 · {state.owner}</p></main>`;
export function writeState(directory, framework, marker) {
  fs.writeFileSync(path.join(directory, framework==='next'?'app/state.json':'src/state.json'), JSON.stringify({owner:marker.startsWith('A')?'Worker A':'Worker B',marker,tasks:[{id:1,status:'进行中',title:'项目界面',detail:'统一任务结构与页面布局。'},{id:2,status:'待检查',title:'工作副本交接',detail:`当前来源：${marker}`},{id:3,status:'已完成',title:'资源生命周期',detail:'从启动到用户停止的事件可追溯。'}]},null,2));
}
export function project(directory, framework, marker, nextMode='--webpack') {
  fs.mkdirSync(directory,{recursive:true});
  fs.symlinkSync(dependencies,path.join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
  const deps=JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'package.json'),'utf8'));
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:`handoff-${framework}`,private:true,type:'module',scripts:{dev:framework==='vite'?'vite':`next dev ${nextMode}`.trim()},dependencies:deps.dependencies},null,2));
  if(framework==='vite') {
    fs.mkdirSync(path.join(directory,'src'));
    fs.writeFileSync(path.join(directory,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>前端交接工作台</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
    fs.writeFileSync(path.join(directory,'src/style.css'),style);
    fs.writeFileSync(path.join(directory,'src/main.jsx'),`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import state from './state.json';import './style.css';function App(){${body.replace('FRAMEWORK','Vite')}}createRoot(document.getElementById('root')).render(<App/>);`);
    fs.writeFileSync(path.join(directory,'vite.config.js'),`import{defineConfig}from'vite';import{readFileSync}from'node:fs';export default defineConfig({plugins:[{name:'runtime-observation',configureServer(server){server.middlewares.use('/api/runtime',(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({...JSON.parse(readFileSync('src/state.json','utf8')),pid:process.pid,cwd:process.cwd()}));});}}]});`);
  }else {
    fs.mkdirSync(path.join(directory,'app/api/runtime'),{recursive:true});
    fs.writeFileSync(path.join(directory,'app/global.css'),style);
    fs.writeFileSync(path.join(directory,'app/layout.jsx'),`import './global.css';export const metadata={title:'前端交接工作台'};export default function Layout({children}){return <html lang="zh-CN"><body>{children}</body></html>}`);
    fs.writeFileSync(path.join(directory,'app/page.jsx'),`'use client';import {useState}from'react';import state from './state.json';export default function Page(){${body.replace('FRAMEWORK','Next.js')}}`);
    fs.writeFileSync(path.join(directory,'app/api/runtime/route.js'),`import state from '../../state.json';export const dynamic='force-dynamic';export async function GET(){return Response.json({...state,pid:process.pid,cwd:process.cwd()})}`);
  }
  writeState(directory,framework,marker);
}
