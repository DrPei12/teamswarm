import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { commitPreparedDirectory } from "../src/runtime/prepared-directory.js";

test("new-directory commits recover transient Windows locks and never replace an existing destination", () => {
  const root=mkdtempSync(path.join(os.tmpdir(),"teamswarm-directory-"));
  try {
    const source=path.join(root,"staging"),target=path.join(root,"work");
    mkdirSync(source);writeFileSync(path.join(source,"owned.txt"),"content");
    let attempts=0;const waits:number[]=[];
    commitPreparedDirectory(source,target,{platform:"win32",wait:ms=>waits.push(ms),rename:(from,to)=>{
      if(++attempts<3)throw Object.assign(new Error("scanner holds directory"),{code:"EPERM"});
      renameSync(from,to);
    }});
    assert.equal(readFileSync(path.join(target,"owned.txt"),"utf8"),"content");
    assert.equal(attempts,3);assert.deepEqual(waits,[10,25]);
    mkdirSync(source);writeFileSync(path.join(source,"new.txt"),"preserve");
    assert.throws(()=>commitPreparedDirectory(source,target),(e:any)=>e.code==="workspace_exists");
    assert.equal(readFileSync(path.join(source,"new.txt"),"utf8"),"preserve");
    let count=0;
    assert.throws(()=>commitPreparedDirectory(source,path.join(root,"unavailable"),{platform:"win32",wait:()=>{},rename:()=>{
      count++;throw Object.assign(new Error("denied"),{code:"EPERM"});
    }}),/denied/);
    assert.equal(count,6);
  } finally {rmSync(root,{recursive:true,force:true});}
});
