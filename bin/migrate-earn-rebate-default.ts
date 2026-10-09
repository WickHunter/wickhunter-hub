import path from 'node:path';
import fs from 'node:fs';
import { EarnService } from '../src/earn.js';

const args=process.argv.slice(2);
let dataDir='';let apply=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--data-dir'&&args[i+1])dataDir=path.resolve(args[++i]);
  else if(args[i]==='--apply')apply=true;
  else throw new Error('Usage: node dist/bin/migrate-earn-rebate-default.js --data-dir <hub-data-dir> [--apply]');
}
if(!dataDir)throw new Error('Pass --data-dir explicitly; no default Hub data directory is assumed');
if(!fs.statSync(dataDir,{throwIfNoEntry:false})?.isDirectory())throw new Error('Hub data directory does not exist');
if(!fs.statSync(path.join(dataDir,'earn.v1.json'),{throwIfNoEntry:false})?.isFile())throw new Error('earn.v1.json is missing; refusing to migrate an empty or incorrect directory');
const result=new EarnService(dataDir).migrateDefaultRebateShare(apply);
console.log(`${apply?'Applied':'Dry run'}: ${result.count} untouched legacy 50% WH share default(s) ${apply?'changed to 35%':'eligible for 35%'}.`);
