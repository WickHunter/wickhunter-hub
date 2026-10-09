#!/usr/bin/env node
// Reviewed operator request through the running Hub's existing admin boundary.
// No direct Earn-store writes, coupon creation, payout or subscription changes.
import {configFromEnv} from '../dist/src/config.js';
if(process.argv.length!==3||process.argv[2]!=='--execute-reviewed-live'){
 console.log('Prospective only. After reviewed Hub deployment: --execute-reviewed-live links the exact three existing LIVE Oskaras offers and enables the reviewed read-only11122 dashboard; then reconciles subscription status without financial replay.');
 process.exitCode=2;
}else{
 const cfg=configFromEnv();
 if(!cfg.adminToken)throw Error('Existing Hub admin credential is required');
 const base=`http://127.0.0.1:${cfg.port}`;
 const request=async(action,body)=>{
  const res=await fetch(base+'/admin/api/earn/'+action,{method:'POST',redirect:'error',headers:{'x-hub-admin':cfg.adminToken,'content-type':'application/json','x-wh-earn':'1'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
  const result=await res.json();if(!res.ok||!result.ok)throw Error(result.error||'Hub declined reviewed operation');return result.result;
 };
 const linked=await request('oskaras-link',{email:'oskarasridikas@gmail.com',confirm:'LINK EXISTING LIVE OSKARAS OFFERS'});
 const status=await request('referral-status-refresh',{owner:linked.owner});
 console.log(JSON.stringify({linked:linked.linked,dashboardReadOnly:linked.dashboardReadOnly,offers:3,referralStatuses:status.count,financialReplay:false}));
}
