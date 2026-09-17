import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {EarnService,earnOwner,tierPercent,type EarnState,type Entry,type EarnSource} from './earn.js';
import {EarnStripeApi,EarnStripeError,type StripeObject} from './earn-stripe-api.js';
import {readJson,writeJsonAtomic} from './jsonfile.js';
import type {BillingConfig,BillingMode} from './billing/config.js';
import type {StripeEvent} from './billing/stripe.js';

type Settings={mode:BillingMode; enabled:boolean; automatic:boolean; payoutDay:number; financialAccount:string};
type Job={id:string;owner:string;cycle:string;recipient:string;financialAccount:string;amount:number;allocations:{source:EarnSource;cents:number}[];status:string;created:number;stripeId?:string;error?:string;released?:boolean;paid?:boolean;returned?:boolean;checked?:number};
type Invoice={id:string;owner:string;subscription:string;customer:string;paid:number;basis:number;commission:number;rate:number;period:string;paidThrough:number;charges:string[];refunded:number;disputed:boolean};
const sources:EarnSource[]=['referral','exchange','marketplace'];
const defaults:Settings={mode:'test',enabled:false,automatic:false,payoutDay:1,financialAccount:''};
const id=(v:unknown)=>typeof v==='string'?v:typeof v==='object'&&v!==null?String((v as StripeObject).id||''):'';
const money=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=100_000_000?Number(n):null;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,40);
function book(s:EarnState):StripeObject { return s.stripe??=( {profiles:{},invoices:{},jobs:[],seen:{}} ); }
function entry(owner:string,source:EarnSource,kind:Entry['kind'],cents:number,reference:string,period:string,note:string,now:number):Entry {
 return {id:randomUUID(),owner,source,kind,cents,currency:'USD',period,reference,note,method:kind==='payout'?'Stripe Global Payouts':'',createdAt:new Date(now).toISOString(),actor:'stripe',...(kind==='payout'?{paidAt:new Date(now).toISOString().slice(0,10)}:{})};
}
/** A single Hub process serializes remote side effects. Money is reserved durably
 * BEFORE submission; unknown outcomes retain that reservation across restarts. */
export class EarnStripeService {
 private tail:Promise<unknown>=Promise.resolve(); private timer:ReturnType<typeof setInterval>|undefined; private tickRunning=false; private lastError:string|null=null;
 private testLedger:EarnService;
 constructor(private dir:string,private liveLedger:EarnService,private billing:()=>BillingConfig,private origin:string,private now=Date.now,private fetcher:typeof fetch=fetch){this.testLedger=new EarnService(path.join(dir,'earn-test'),now);}
 settings():Settings {return {...defaults,...readJson<Partial<Settings>>(path.join(this.dir,'earn-stripe-config.v1.json'),{})};}
 configure(input:Record<string,unknown>) {
  const c=this.settings(),wasAutomatic=c.automatic;for(const k of ['enabled','automatic'] as const)if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw Error('Invalid switch');c[k]=input[k];}
  if(input.mode!==undefined){if(!['test','live'].includes(String(input.mode)))throw Error('Invalid mode');if(wasAutomatic && c.automatic && input.mode!==c.mode)throw Error('Disable automatic payouts before switching modes');c.mode=input.mode as BillingMode;}
  if(input.payoutDay!==undefined){if(!Number.isInteger(input.payoutDay)||Number(input.payoutDay)<1||Number(input.payoutDay)>28)throw Error('Choose payout day 1–28');c.payoutDay=Number(input.payoutDay);}
  if(input.financialAccount!==undefined){if(!/^$|^fa_(?:test_)?[A-Za-z0-9]+$/.test(String(input.financialAccount)))throw Error('Invalid financial account');if(wasAutomatic&&c.automatic&&input.financialAccount!==c.financialAccount)throw Error('Disable automatic payouts before changing financial account');c.financialAccount=String(input.financialAccount);}
  if(c.automatic&&(!c.enabled||!c.financialAccount))throw Error('Enable earnings and select a verified Stripe financial account first');
  if(input.payoutKey!==undefined && input.payoutKey!==''){
   const key=String(input.payoutKey).trim();
   if(!(c.mode==='live'?/^rk_live_[A-Za-z0-9]+$/:/^(?:sk|rk)_test_[A-Za-z0-9]+$/).test(key))throw Error(c.mode==='live'?'Live Global Payouts requires a restricted rk_live_ key':'Enter a Sandbox secret key');
   const file=path.join(this.dir,'earn-stripe-secrets.v1.json'),keys=readJson<Partial<Record<BillingMode,string>>>(file,{});keys[c.mode]=key;writeJsonAtomic(file,keys);
  }
  writeJsonAtomic(path.join(this.dir,'earn-stripe-config.v1.json'),c);return c;
 }
 ledger(mode:BillingMode){return mode==='live'?this.liveLedger:this.testLedger;}
 private api(mode:BillingMode){const key=this.billing().stripe[mode].secretKey;if(!key||!(key.startsWith(mode==='live'?'sk_live_':'sk_test_')||key.startsWith(mode==='live'?'rk_live_':'rk_test_')))throw Error(`A ${mode} Stripe key is required`);return new EarnStripeApi(key,this.fetcher);}
 private payoutApi(mode:BillingMode){
  const keys=readJson<Partial<Record<BillingMode,string>>>(path.join(this.dir,'earn-stripe-secrets.v1.json'),{});
  const key=keys[mode];if(key)return new EarnStripeApi(key,this.fetcher);
  if(mode==='test')return this.api(mode);
  throw Error('Save a restricted live Global Payouts key in Earn settings; keep billing keys unchanged');
 }
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const next=this.tail.then(fn,fn);this.tail=next.catch(()=>{});return next;}
 private profile(mode:BillingMode,owner:string){return book(this.ledger(mode).admin()).profiles[owner]||{};}
 private updateProfile(mode:BillingMode,owner:string,patch:StripeObject){this.ledger(mode).transaction(s=>{const b=book(s);b.profiles[owner]={...b.profiles[owner],...patch};});}
 private syncMember(mode:BillingMode,owner:string){const m=this.liveLedger.admin().members.find(m=>m.id===owner);if(!m)throw Error('Member not found');if(mode==='test')this.testLedger.copyMember(m);return m;}
 view(owner:string){const c=this.settings(),p=this.profile(c.mode,owner);return {mode:c.mode,enabled:c.enabled,automatic:c.automatic,payoutDay:c.payoutDay,referralUrl:c.enabled&&p.promotion?`${this.origin}/buy?ref=${encodeURIComponent(p.code)}`:null,recipient:!!p.recipient,recipientStatus:p.status||'not_connected',jobs:(book(this.ledger(c.mode).admin()).jobs as Job[]).filter(j=>j.owner===owner).map(j=>({id:j.id,cycle:j.cycle,amount:j.amount,status:j.status,error:j.error})),test:c.mode==='test'?this.testLedger.view(owner,this.liveLedger.admin().members.find(m=>m.id===owner)?.name||'Test member'):undefined};}
 admin(){const c=this.settings();return {settings:c,payoutKeyConfigured:!!readJson<Partial<Record<BillingMode,string>>>(path.join(this.dir,'earn-stripe-secrets.v1.json'),{})[c.mode],lastError:this.lastError,...book(this.ledger(c.mode).admin())};}
 async readiness(){const c=this.settings();const accounts=await this.payoutApi(c.mode).call('GET','/v2/money_management/financial_accounts');return {mode:c.mode,accounts:(accounts.data||[]).map((a:StripeObject)=>({id:a.id,status:a.status,currencies:a.storage?.holds_currencies||[],availableUsd:a.balance?.available?.usd?.value??null}))};}
 activate(owner:string){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earnings are not enabled');const m=this.syncMember(c.mode,owner),api=this.api(c.mode);const p=this.profile(c.mode,owner);
  const plans=this.billing().plans.filter(p=>p.role==='software'&&p.interval&&p.checkout==='payment-link'&&p.currency==='usd');
  const products:string[]=[];for(const plan of plans){const priceId=this.billing().stripe[c.mode].priceIds[plan.key];if(!priceId)continue;const price=await api.call('GET','/v1/prices/'+priceId);if(price.active===true&&price.recurring?.interval===plan.interval&&price.currency==='usd')products.push(id(price.product));}
  if(!products.length)throw Error('Create the recurring WH software plans in Stripe first');
  const signature=hash(JSON.stringify([m.code,m.discountPercent,[...new Set(products)].sort()]));if(p.signature===signature&&p.promotion)return this.view(owner);
  if(m.discountPercent<1)throw Error('Referral discounts must be at least 1% to create a promotion code');
  const couponId='wh_earn_'+signature;
  let coupon:StripeObject;try{coupon=await api.call('GET','/v1/coupons/'+couponId);}catch(e){if(!(e instanceof EarnStripeError)||e.status!==404)throw e;coupon=await api.call('POST','/v1/coupons',{id:couponId,duration:'forever',percent_off:m.discountPercent,'metadata[managed_by]':'wh-earn',...Object.fromEntries([...new Set(products)].map((v,i)=>[`applies_to[products][${i}]`,v]))},{key:couponId});}
  if(coupon.percent_off!==m.discountPercent||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn')throw Error('Existing Stripe coupon does not match this referral');
  // Changed discounts create a new public code; existing subscribers retain the discount they accepted.
  const code=p.promotion?m.code+signature.slice(0,6).toUpperCase():m.code;
  const existing=await api.call('GET','/v1/promotion_codes',{code,active:true,limit:100});let promo=(existing.data||[]).find((x:StripeObject)=>x.code?.toUpperCase()===code);
  if(promo && (id(promo.coupon)!==coupon.id||promo.metadata?.wh_earn_owner!==owner))throw Error('Referral code belongs to a different Stripe promotion');
  promo??=await api.call('POST','/v1/promotion_codes',{coupon:coupon.id,code,'metadata[wh_earn_owner]':owner,'metadata[managed_by]':'wh-earn'},{key:'promo_'+signature});
  if(!id(promo))throw Error('Stripe did not return a promotion code');
  if(p.promotion)await api.call('POST','/v1/promotion_codes/'+p.promotion,{active:false},{key:'retire_'+p.promotion});
  this.updateProfile(c.mode,owner,{code,promotion:promo.id,signature});return this.view(owner);
 });}
 checkout(code:string,planKey?:string|null){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Referrals are not available');const b=book(this.ledger(c.mode).admin());const found=Object.entries(b.profiles).find(([,p])=>(p as StripeObject).code===code) as [string,StripeObject]|undefined;if(!found)throw Error('Referral code not found');
  const [owner,p]=found,m=this.syncMember(c.mode,owner),cfg=this.billing();const plan=cfg.plans.find(x=>x.key===(planKey||'monthly')&&x.role==='software'&&x.interval&&x.checkout==='payment-link'&&x.currency==='usd');const price=plan&&cfg.stripe[c.mode].priceIds[plan.key];if(!plan||!price)throw Error('This recurring subscription plan is unavailable');
  const r=await this.api(c.mode).call('POST','/v1/checkout/sessions',{mode:'subscription','line_items[0][price]':price,'line_items[0][quantity]':1,'discounts[0][promotion_code]':p.promotion,'metadata[plan]':plan.key,'metadata[managed_by]':'wickhunter-hub','metadata[wh_earn_code]':m.code,'subscription_data[metadata][plan]':plan.key,'subscription_data[metadata][wh_earn_code]':m.code,'subscription_data[metadata][managed_by]':'wickhunter-hub',success_url:this.origin+'/customer?checkout=complete',cancel_url:this.origin+'/customer'},{key:'earn_checkout_'+randomUUID()});
  if(typeof r.url!=='string'||new URL(r.url).hostname!=='checkout.stripe.com')throw Error('Invalid Stripe checkout URL');return r.url;
 });}
 onboard(owner:string,input:Record<string,unknown>){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earnings are not enabled');this.syncMember(c.mode,owner);const api=this.payoutApi(c.mode);let p=this.profile(c.mode,owner);
  if(!p.recipient){const country=String(input.country||'').toLowerCase(),email=String(input.email||'').trim().toLowerCase(),entity=String(input.entity||'individual'),network=String(input.network||'local');if(!/^[a-z]{2}$/.test(country)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!['individual','company'].includes(entity)||!['local','wire'].includes(network))throw Error('Enter your email, two-letter country code and account type');
   // Persist the exact creation request before the API call so retries reuse both key and body.
   if(!p.request){this.updateProfile(c.mode,owner,{request:{contact_email:email,identity:{country,entity_type:entity},configuration:{recipient:{capabilities:{bank_accounts:{[network]:{requested:true}}}}},metadata:{wh_earn_owner:owner},include:['configuration.recipient','requirements','identity']},requestAt:this.now()});p=this.profile(c.mode,owner);}
   if(this.now()-p.requestAt>23*3600000)throw Error('Recipient creation needs reconciliation before retrying; contact WH');
   const a=await api.call('POST','/v2/core/accounts',p.request,{key:'earn_recipient_'+hash(c.mode+owner)});if(!id(a).startsWith('acct_'))throw Error('Invalid Stripe recipient');this.updateProfile(c.mode,owner,{recipient:a.id,status:'onboarding'});p=this.profile(c.mode,owner);
  }
  const ret=this.origin+'/earn';const link=await api.call('POST','/v2/core/account_links',{account:p.recipient,use_case:{type:'account_onboarding',account_onboarding:{configurations:['recipient'],return_url:ret,refresh_url:ret}}},{key:'earn_link_'+randomUUID()});
  if(typeof link.url!=='string'||new URL(link.url).protocol!=='https:'||!['accounts.stripe.com','connect.stripe.com','onboarding.stripe.com'].includes(new URL(link.url).hostname))throw Error('Unexpected Stripe onboarding URL');return {url:link.url};
 });}
 private async recipient(mode:BillingMode,owner:string){const p=this.profile(mode,owner);if(!p.recipient)return null;const a=await this.payoutApi(mode).call('GET','/v2/core/accounts/'+p.recipient,{'include[0]':'configuration.recipient','include[1]':'defaults'});const cap=a.configuration?.recipient?.capabilities?.bank_accounts;const ready=(cap?.local?.status==='active'||cap?.wire?.status==='active')&&!!id(a.defaults?.payout_methods?.usd);this.updateProfile(mode,owner,{status:ready?'ready':'needs_information'});return ready?p.recipient:null;}
 refresh(owner:string){return this.serial(async()=>{await this.recipient(this.settings().mode,owner);return this.view(owner);});}
 handleEvent(ev:StripeEvent){return this.serial(async()=>{
  // Pausing new enrollments/payouts must never discard renewals, refunds or disputes
  // for already attributed subscriptions. Invoice admission still requires a known profile.
  const mode:BillingMode=ev.livemode?'live':'test';
  if(!['invoice.paid','invoice.payment_succeeded','customer.subscription.updated','customer.subscription.deleted','charge.refunded','charge.dispute.created','charge.dispute.closed'].includes(ev.type))return;
  const ledger=this.ledger(mode),b=book(ledger.admin());if(b.seen[ev.id])return;
  // An unconfigured private program must not add Stripe dependencies to ordinary billing.
  if(!Object.values(b.profiles).some((p:any)=>p.promotion)&&!Object.keys(b.invoices).length)return;
  const api=this.api(mode),o=ev.object;
  if(['invoice.paid','invoice.payment_succeeded'].includes(ev.type))await this.invoice(mode,id(o));
  else if(ev.type.startsWith('customer.subscription.')){
   const tracked=ledger.admin().referrals.find(r=>r.subscription===id(o));if(tracked){const sub=await api.call('GET','/v1/subscriptions/'+id(o));ledger.transaction(s=>{const r=s.referrals.find(r=>r.subscription===sub.id);if(r)r.active=sub.status==='active'&&(Object.values(book(s).invoices) as Invoice[]).some(i=>i.subscription===sub.id&&i.paidThrough>this.now()&&!i.disputed&&i.refunded<i.paid);});}
  } else if(['charge.refunded','charge.dispute.created','charge.dispute.closed'].includes(ev.type)){
   const charge=ev.type==='charge.refunded'?id(o):id(o.charge);if(charge){const row=(Object.values(b.invoices) as Invoice[]).find(i=>i.charges.includes(charge));if(row)await this.adjustInvoice(mode,row.id);else{const ch=await api.call('GET','/v1/charges/'+charge);if(id(ch.invoice))await this.invoice(mode,id(ch.invoice));}}
  }
  ledger.transaction(s=>{book(s).seen[ev.id]=this.now();});
 });}
 private async invoice(mode:BillingMode,invoiceId:string){
  const ledger=this.ledger(mode),api=this.api(mode);if(book(ledger.admin()).invoices[invoiceId]){await this.adjustInvoice(mode,invoiceId);return;}
  const inv=await api.call('GET','/v1/invoices/'+invoiceId,{'expand[0]':'payments.data.payment.payment_intent'});
  const subscription=id(inv.parent?.subscription_details?.subscription)||id(inv.subscription);if(!subscription||inv.status!=='paid'||inv.currency!=='usd'||inv.livemode!==(mode==='live'))return;
  const sub=await api.call('GET','/v1/subscriptions/'+subscription);const member=this.liveLedger.admin().members.find(m=>m.code===sub.metadata?.wh_earn_code);if(!member)return;
  const p=this.profile(mode,member.id);if(!p.promotion)return;
  const cfg=this.billing(),allowed=new Set(cfg.plans.filter(p=>p.role==='software'&&p.interval&&p.checkout==='payment-link').map(p=>cfg.stripe[mode].priceIds[p.key]).filter(Boolean));
  const items=sub.items?.data||[];if(!items.length||sub.items?.has_more||items.some((i:StripeObject)=>!allowed.has(id(i.price))))return;
  const lines=inv.lines?.data||[];if(!lines.length||inv.lines?.has_more||lines.some((l:StripeObject)=>!allowed.has(id(l.pricing?.price_details?.price)||id(l.price))))return;
  const cust=await api.call('GET','/v1/customers/'+id(inv.customer));if(earnOwner('email:'+String(cust.email||'').trim().toLowerCase())===member.id)return;
  const paid=money(inv.amount_paid),total=money(inv.total_excluding_tax);if(paid===null||total===null||paid===0)return;
  const taxes=inv.total_taxes||inv.total_tax_amounts||[];if(!Array.isArray(taxes)||taxes.some((t:StripeObject)=>money(t.amount)===null))throw Error('Invoice tax total is unavailable');
  const basis=Math.min(total,Math.max(0,paid-taxes.reduce((n:number,t:StripeObject)=>n+t.amount,0)));if(!basis)return;
  // Retrieve every invoice payment rather than assuming the first charge is the whole invoice.
  const paymentRows=await api.call('GET','/v1/invoice_payments',{invoice:invoiceId,status:'paid',limit:100,'expand[0]':'data.payment.payment_intent'});if(paymentRows.has_more)throw Error('Invoice payment history requires manual review');
  const charges:string[]=[];for(const row of paymentRows.data||[]){if(row.status!=='paid')continue;const payment=row.payment;if(payment?.type==='payment_intent'){let pi=payment.payment_intent;if(typeof pi==='string')pi=await api.call('GET','/v1/payment_intents/'+pi);if(id(pi?.latest_charge))charges.push(id(pi.latest_charge));}else if(payment?.type==='charge'&&id(payment.charge))charges.push(id(payment.charge));}
  // Only real collected charge-backed invoices enter payable earnings.
  if(!charges.length)return;
  const paidThrough=Math.max(...lines.map((l:StripeObject)=>Number(l.period?.end||0)*1000));const period=new Date(Number(inv.status_transitions?.paid_at||inv.created)*1000).toISOString().slice(0,7);
  this.syncMember(mode,member.id);
  ledger.transaction(s=>{const b=book(s);if(b.invoices[invoiceId])return;let r=s.referrals.find(r=>r.subscription===subscription);if(r&&r.code!==member.code)throw Error('Subscription referral attribution cannot change');
   if(!r){r={code:member.code,subscription,customer:id(inv.customer),active:false};s.referrals.push(r);}r.active=sub.status==='active';r.paidThrough=Math.max(r.paidThrough||0,paidThrough);
   const count=s.referrals.filter(r=>r.code===member.code&&r.active&&(r.paidThrough||0)>this.now()).length;
   const rate=member.commissionPercent??tierPercent(count),commission=Math.floor(basis*rate/100);
   b.invoices[invoiceId]={id:invoiceId,owner:member.id,subscription,customer:id(inv.customer),paid,basis,commission,rate,period,paidThrough,charges,refunded:0,disputed:false};
   if(commission)s.entries.push(entry(member.id,'referral','earning',commission,'stripe:invoice:'+invoiceId,period,`${rate}% recurring referral commission`,this.now()));
  });await this.adjustInvoice(mode,invoiceId);
 }
 private async adjustInvoice(mode:BillingMode,invoiceId:string){
  const ledger=this.ledger(mode),row=book(ledger.admin()).invoices[invoiceId] as Invoice|undefined;if(!row)return;
  let refunded=0,disputed=false;for(const charge of row.charges){const ch=await this.api(mode).call('GET','/v1/charges/'+charge);if(ch.livemode!==(mode==='live'))throw Error('Charge mode mismatch');const amount=money(ch.amount_refunded);if(amount===null)throw Error('Refund amount unavailable');refunded+=amount;if(ch.disputed===true){const ds=await this.api(mode).call('GET','/v1/disputes',{charge,limit:100});if(ds.has_more)throw Error('Dispute history needs review');disputed ||= !ds.data?.length || ds.data.some((d:StripeObject)=>!['won','warning_closed'].includes(d.status));}}
  const subscription=await this.api(mode).call('GET','/v1/subscriptions/'+row.subscription);
  const target=disputed?row.commission:Math.min(row.commission,Math.floor(row.commission*Math.min(refunded,row.paid)/row.paid));
  ledger.transaction(s=>{const b=book(s),i=b.invoices[invoiceId] as Invoice;const previous=i.disputed?i.commission:Math.min(i.commission,Math.floor(i.commission*Math.min(i.refunded,i.paid)/i.paid));const delta=previous-target;
   if(delta)s.entries.push(entry(i.owner,'referral','adjustment',delta,'stripe:adjust:'+invoiceId+':'+randomUUID(),i.period,disputed?'Referral commission held for a disputed payment':'Referral commission reconciled to Stripe refund/dispute status',this.now()));i.refunded=refunded;i.disputed=disputed;
   const r=s.referrals.find(r=>r.subscription===i.subscription);if(r)r.active=subscription.status==='active'&&(Object.values(b.invoices) as Invoice[]).some(v=>v.subscription===i.subscription&&v.paidThrough>this.now()&&!v.disputed&&v.refunded<v.paid);
  });
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>{if(this.tickRunning)return;this.tickRunning=true;void this.run().then(()=>{this.lastError=null;},e=>{this.lastError=e instanceof EarnStripeError?e.message:'Payout reconciliation needs attention';}).finally(()=>{this.tickRunning=false;});},60_000);this.timer.unref();}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 run(){return this.serial(async()=>{
  const c=this.settings();const mode=c.mode,ledger=this.ledger(mode);let jobs=book(ledger.admin()).jobs as Job[];
  // Reconcile even when automatic dispatch is paused. Submitted money still needs accounting.
  for(const rail of ['test','live'] as const){const candidates=(book(this.ledger(rail).admin()).jobs as Job[]).filter(j=>j.stripeId&&!['returned','failed','canceled'].includes(j.status)).sort((a,b)=>(a.checked||0)-(b.checked||0));for(const job of candidates.slice(0,100))try{await this.reconcile(rail,job);}catch(e){this.jobError(rail,job.id,e);}}
  if(!c.enabled||!c.automatic)return;
  const date=new Date(this.now());if(date.getUTCDate()<c.payoutDay)return;const cycle=date.toISOString().slice(0,7);
  const fa=await this.payoutApi(mode).call('GET','/v2/money_management/financial_accounts/'+c.financialAccount);if(fa.status!=='open'||fa.livemode!==(mode==='live'))throw Error('The payout financial account is not open in this mode');
  for(const m of ledger.admin().members){
   jobs=book(ledger.admin()).jobs as Job[];const old=jobs.find(j=>j.owner===m.id&&j.cycle===cycle);
   if(old){if(!old.stripeId&&old.status==='submitting')await this.submit(mode,old,c);continue;}
   let recipient:string|null;try{recipient=await this.recipient(mode,m.id);}catch{continue;}if(!recipient)continue;
   const job=ledger.transaction(s=>{const b=book(s);if(b.jobs.some((j:Job)=>j.owner===m.id&&j.cycle===cycle))return null;
    const totals=sources.map(source=>({source,cents:s.entries.filter(e=>e.owner===m.id&&e.source===source).reduce((n,e)=>n+(e.period<cycle?e.cents:Math.min(0,e.cents)),0)}));
    // A debt in any program reduces the combined payable amount.
    let debt=-totals.filter(a=>a.cents<0).reduce((n,a)=>n+a.cents,0);const allocations=totals.filter(a=>a.cents>0).map(a=>{const offset=Math.min(a.cents,debt);debt-=offset;return {...a,cents:a.cents-offset};}).filter(a=>a.cents>0);const amount=allocations.reduce((n,a)=>n+a.cents,0);if(amount<1)return null;
    const job:Job={id:randomUUID(),owner:m.id,cycle,recipient:recipient!,financialAccount:c.financialAccount,amount,allocations,status:'submitting',created:this.now()};b.jobs.push(job);
    for(const a of allocations)s.entries.push(entry(m.id,a.source,'hold',-a.cents,'stripe:hold:'+job.id+':'+a.source,cycle,'Reserved for automatic Stripe payout',this.now()));return job;
   });if(job)await this.submit(mode,job,c);
  }
 });}
 private jobError(mode:BillingMode,jobId:string,error:unknown){this.ledger(mode).transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===jobId);if(j){j.checked=this.now();j.error=error instanceof EarnStripeError?error.message:'Stripe could not be reached; reconciliation will retry';}});}
 private async submit(mode:BillingMode,job:Job,c:Settings){
  if(this.now()-job.created>23*3600000){this.ledger(mode).transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===job.id)!;j.status='needs_review';j.error='Unknown submission outcome; reconcile in Stripe before releasing this reservation';});return;}
  let accepted=false;try{const result=await this.payoutApi(mode).call('POST','/v2/money_management/outbound_payments',{from:{financial_account:job.financialAccount,currency:'usd'},to:{recipient:job.recipient},amount:{value:job.amount,currency:'usd'},description:`Wick Hunter earnings ${job.cycle}`,metadata:{wh_payout_id:job.id}},{key:'wh_payout_'+job.id});if(!id(result))throw Error('Missing outbound payment ID');accepted=true;this.ledger(mode).transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===job.id)!;j.stripeId=result.id;});await this.reconcile(mode,{...job,stripeId:result.id});}
  catch(e){this.jobError(mode,job.id,e);if(!accepted&&e instanceof EarnStripeError&&[400,402,403,404,422].includes(e.status))this.settle(mode,job.id,'failed');}
 }
 private async reconcile(mode:BillingMode,job:Job){const result=await this.payoutApi(mode).call('GET','/v2/money_management/outbound_payments/'+job.stripeId);if(result.amount?.value!==job.amount||result.amount?.currency!=='usd'||id(result.to?.recipient)!==job.recipient||result.livemode!==(mode==='live'))throw Error('Stripe payout identity mismatch');this.settle(mode,job.id,result.status);}
 private settle(mode:BillingMode,jobId:string,status:string){
  if(!['processing','posted','failed','canceled','returned'].includes(status))return;
  this.ledger(mode).transaction(s=>{const job=(book(s).jobs as Job[]).find(j=>j.id===jobId)!;
   if(job.returned||(['failed','canceled'].includes(job.status)))return;
   if(status==='posted'&&!job.paid){for(const a of job.allocations){s.entries.push(entry(job.owner,a.source,'release',a.cents,'stripe:release:'+job.id+':'+a.source,job.cycle,'Reservation settled by Stripe',this.now()));s.entries.push(entry(job.owner,a.source,'payout',-a.cents,'stripe:payout:'+job.id+':'+a.source,job.cycle,'Stripe payout sent (bank arrival may follow)',this.now()));}job.paid=true;job.released=true;}
   if(['failed','canceled','returned'].includes(status))for(const a of job.allocations){if(job.paid&&!job.returned){const orig=s.entries.find(e=>e.reference==='stripe:payout:'+job.id+':'+a.source)!;const reversal=entry(job.owner,a.source,'reversal',a.cents,'stripe:return:'+job.id+':'+a.source,job.cycle,'Stripe payout returned; earnings restored',this.now());reversal.reverses=orig.id;s.entries.push(reversal);}else if(!job.released)s.entries.push(entry(job.owner,a.source,'release',a.cents,'stripe:release:'+job.id+':'+a.source,job.cycle,'Stripe payout did not complete; earnings restored',this.now()));}
   if(['failed','canceled','returned'].includes(status)){job.released=true;job.returned=job.paid||status==='returned';}job.status=status;job.checked=this.now();if(status==='posted')delete job.error;
  });
 }
}
