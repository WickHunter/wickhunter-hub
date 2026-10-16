import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('hosting-deduction');let now=Date.parse('2026-10-16T16:00:00Z');
const earn=new EarnService(dir,()=>now),owner=earnOwner('oskaras-fixture'),other=earnOwner('other-fixture');
earn.member(owner,'Partner');earn.member(other,'Other');
try{
 await test('hosting is opt-in and existing members have no deductions',()=>{
  assert.equal(earn.assessHostingFees().count,0);assert.equal(earn.view(other,'Other').hostingStatement,null);
 });
 await test('one monthly line item reduces earnings without becoming a payout or changing the rate',()=>{
  earn.record({owner,source:'referral',kind:'earning',cents:10000,reference:'fixture-paid-invoice',note:'50% commission',period:'2026-10'});
  earn.configure({owner,commissionPercent:50,hostingFee:{monthlyCents:2000,startPeriod:'2026-10'}});
  const v=earn.view(owner,'Partner');assert.equal(v.balances.referral,8000);assert.equal(v.commissionPercent,50);assert.equal(v.paidCents,0);
  assert.deepEqual(v.hostingStatement.rows,[{period:'2026-10',grossCents:10000,hostingCents:2000,netCents:8000}]);
  const fee=v.entries.find(e=>e.reference.startsWith('hosting-fee:'));assert.equal(fee.cents,-2000);assert.equal(fee.kind,'adjustment');assert.match(fee.note,/VPS hosting.*20.00\/month/);
  assert.equal(earn.view(other,'Other').balances.referral,0);assert.equal(earn.view(other,'Other').hostingStatement,null);
 });
 await test('repeated ticks and configuration never duplicate fees; missed months retain separate references',()=>{
  const before=earn.fileVersion();assert.equal(earn.assessHostingFees().count,0);assert.equal(earn.fileVersion(),before);
  earn.configure({owner,hostingFee:{monthlyCents:2000,startPeriod:'2026-10'}});assert.equal(earn.view(owner,'Partner').balances.referral,8000);
  now=Date.parse('2026-12-01T00:00:00Z');assert.equal(earn.assessHostingFees().count,2);assert.equal(earn.assessHostingFees().count,0);
  assert.equal(earn.view(owner,'Partner').balances.referral,4000);assert.equal(earn.admin().entries.filter(e=>e.reference.startsWith('hosting-fee:')).length,3);
 });
 await test('disable stops future fees and reversing a charged month does not charge it again',()=>{
  const oct=earn.admin().entries.find(e=>e.reference.endsWith(':2026-10'));earn.reverse({id:oct.id,note:'Operator fee credit'});
  assert.equal(earn.assessHostingFees().count,0);assert.equal(earn.view(owner,'Partner').hostingStatement.rows.find(r=>r.period==='2026-10').hostingCents,0);
  earn.configure({owner,hostingFee:null});now=Date.parse('2027-01-01T00:00:00Z');assert.equal(earn.assessHostingFees().count,0);
  assert.throws(()=>earn.configure({owner,hostingFee:{monthlyCents:-2000,startPeriod:'2027-01'}}),/positive/);
 });
}finally{fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-hosting-deduction');
