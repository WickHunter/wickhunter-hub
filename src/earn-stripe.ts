import {OSKARAS_EXISTING_OFFERS,OSKARAS_EXISTING_PRODUCT,OSKARAS_PROOF_KIND,verifyExistingOskaras} from './earn-oskaras-offers.js';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {EarnService,earnOwner,boundOwnerFromBindings,tierPercent,type EarnState,type Entry,type EarnSource} from './earn.js';
import {EarnStripeApi,EarnStripeError,type StripeObject} from './earn-stripe-api.js';
import {readJson,writeJsonAtomic} from './jsonfile.js';
import type {BillingConfig,BillingMode} from './billing/config.js';
import {launchGrant} from './billing/launch.js';
import {BillingStore} from './billing/store.js';
import {componentPriceId,invoiceLineDiscount,invoiceLineNet} from './billing/software-component.js';
import type {StripeEvent} from './billing/stripe.js';

type Settings={mode:BillingMode; enabled:boolean; automatic:boolean; payoutDay:number; financialAccount:string};
type Job={id:string;owner:string;cycle:string;recipient:string;financialAccount:string;amount:number;allocations:{source:EarnSource;cents:number}[];status:string;created:number;stripeId?:string;error?:string;released?:boolean;paid?:boolean;returned?:boolean;checked?:number;identityConflict?:boolean};
type Invoice={id:string;owner:string;subscription:string;customer:string;paid:number;basis:number;commission:number;rate:number;period:string;paidThrough:number;charges:string[];refunded:number;disputed:boolean};
const sources:EarnSource[]=['referral','exchange','marketplace'];
const POSTED_RECHECK_MS=6*60*60_000;
const SEEN_EVENT_MAX=10_000;
const RECOVERY_JOB_LIMIT_PER_MODE=25;
const defaults:Settings={mode:'test',enabled:false,automatic:false,payoutDay:1,financialAccount:''};
const id=(v:unknown)=>typeof v==='string'?v:typeof v==='object'&&v!==null?String((v as StripeObject).id||''):'';
const money=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=100_000_000?Number(n):null;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,40);
/** Stripe's Basil Coupon.applies_to is includable, so it is absent unless the
 *  caller explicitly expands it. Missing/malformed scope is not an empty list. */
function couponProducts(coupon:StripeObject):string[]{
 const raw=coupon.applies_to?.products;
 if(!Array.isArray(raw)||raw.some((value:unknown)=>typeof value!=='string'||!value.trim()))throw Error('Stripe did not return a complete expanded coupon product scope');
 return [...new Set(raw as string[])].sort();
}
const payoutIdentity=(j:Job)=>JSON.stringify([j.id,j.owner,j.cycle,j.recipient,j.financialAccount,j.amount,j.allocations,j.stripeId,j.created]);
/** Consumer Gmail alone documents both dotted usernames and plus tags as one
 * inbox. Workspace/custom domains do not share the dot rule. This key is ONLY
 * a commission exclusion; it never merges customers or Earn owners.
 * https://support.google.com/mail/answer/7436150
 * https://support.google.com/mail/answer/10313
 * https://support.google.com/a/users/answer/9282734 */
function consumerGmailMailbox(raw:unknown):string|null {
 if(typeof raw!=='string')return null;
 const match=/^([a-z0-9.]+)(?:\+[^@\s]+)?@(?:gmail|googlemail)\.com$/.exec(raw.trim().toLowerCase());
 if(!match||match[1].startsWith('.')||match[1].endsWith('.')||match[1].includes('..'))return null;
 return match[1].replaceAll('.','');
}
function book(s:EarnState):StripeObject { return s.stripe??=( {profiles:{},invoices:{},jobs:[],seen:{}} ); }
function entry(owner:string,source:EarnSource,kind:Entry['kind'],cents:number,reference:string,period:string,note:string,now:number):Entry {
 return {id:randomUUID(),owner,source,kind,cents,currency:'USD',period,reference,note,method:kind==='payout'?'Stripe Global Payouts':'',createdAt:new Date(now).toISOString(),actor:'stripe',...(kind==='payout'?{paidAt:new Date(now).toISOString().slice(0,10)}:{})};
}
/** A single Hub process serializes remote side effects. Money is reserved durably
 * BEFORE submission; unknown outcomes retain that reservation across restarts. */
export class EarnStripeService {
 private tail:Promise<unknown>=Promise.resolve(); private timer:ReturnType<typeof setInterval>|undefined; private tickRunning=false; private lastError:string|null=null;
 private payoutScan:Partial<Record<BillingMode,{version:string;nextDue:number;jobs:Job[]}>>={};
 private testLedger:EarnService;
 constructor(private dir:string,private liveLedger:EarnService,private billing:()=>BillingConfig,private origin:string,private now=Date.now,private fetcher:typeof fetch=fetch,
  private boundReferrerEmails?:(mode:BillingMode,owner:string,bindings:Readonly<Record<string,string>>)=>string[]){this.testLedger=new EarnService(path.join(dir,'earn-test'),now);}
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
 private ignoredEventFile(mode:BillingMode){return path.join(this.dir,`earn-stripe-ignored-${mode}.v1.json`);}
 private ignoredEvents(mode:BillingMode):Record<string,number>{return readJson<Record<string,number>>(this.ignoredEventFile(mode),{})||{};}
 private rememberIgnoredEvent(mode:BillingMode,eventId:string){const seen=this.ignoredEvents(mode);seen[eventId]=this.now();const keys=Object.keys(seen);
  if(keys.length>SEEN_EVENT_MAX){keys.sort((a,b)=>(Number(seen[a])||0)-(Number(seen[b])||0));for(const key of keys.slice(0,keys.length-SEEN_EVENT_MAX))delete seen[key];}
  // This sidecar is only a replay filter for proved unrelated signed events.
  // Losing it on a crash causes a harmless re-read, never lost money evidence.
  writeJsonAtomic(this.ignoredEventFile(mode),seen);
 }
 private profile(mode:BillingMode,owner:string){return book(this.ledger(mode).admin()).profiles[owner]||{};}
 private updateProfile(mode:BillingMode,owner:string,patch:StripeObject){this.ledger(mode).transaction(s=>{const b=book(s);b.profiles[owner]={...b.profiles[owner],...patch};});}
 private syncMember(mode:BillingMode,owner:string){const m=this.liveLedger.admin().members.find(m=>m.id===owner);if(!m)throw Error('Member not found');if(mode==='test')this.testLedger.copyMember(m);return m;}
 view(owner:string){const c=this.settings(),p=this.profile(c.mode,owner),m=this.liveLedger.admin().members.find(x=>x.id===owner),proof=p.verifiedPromotion;
  const confirmed=!!(c.enabled&&p.promotion&&proof?.promotion===p.promotion&&proof?.duration==='forever'&&Number.isInteger(proof?.percent));
  return {offers:(Array.isArray(p.partnerPromotions)?p.partnerPromotions:[]).filter((x:StripeObject)=>x.proof?.promotion===x.promotion&&x.proof?.percent===x.percent).map((x:StripeObject)=>({code:x.code,percent:x.percent,duration:'forever',url:`${this.origin}/buy?ref=${encodeURIComponent(x.code)}`})),mode:c.mode,enabled:c.enabled,automatic:c.automatic,payoutDay:c.payoutDay,referralUrl:confirmed?`${this.origin}/buy?ref=${encodeURIComponent(p.code)}`:null,appliedDiscountPercent:m?.discountPercent===0?0:confirmed?proof.percent:null,appliedDiscountDuration:confirmed?'forever':null,activationRequired:!!(c.enabled&&m&&m.discountPercent>0&&!confirmed),recipient:!!p.recipient,recipientStatus:p.status||'not_connected',jobs:(book(this.ledger(c.mode).admin()).jobs as Job[]).filter(j=>j.owner===owner).map(j=>({id:j.id,cycle:j.cycle,amount:j.amount,status:j.status,error:j.error})),test:c.mode==='test'?this.testLedger.view(owner,m?.name||'Test member'):undefined};}
 /** A bounded, owner-filtered status projection, not an earnings calculation.
  * Customer identifiers are opaque labels; no customer/email join occurs here. */
 referralActivity(owner:string,after:string|null=null){
  const c=this.settings(),p=this.profile(c.mode,owner),rows=Array.isArray(p.referralStatus)?p.referralStatus:[];
  const selected=rows.filter((r:StripeObject)=>r.owner===owner).sort((a:StripeObject,b:StripeObject)=>String(a.id).localeCompare(String(b.id)));
  if(after!==null&&!/^[a-f0-9]{40}$/.test(after))throw Error('Invalid referral cursor');
  const page=selected.filter((r:StripeObject)=>!after||r.id>after).slice(0,51),more=page.length>50;
  return {asOf:p.referralStatusAt??null,stale:!p.referralStatusAt||this.now()-p.referralStatusAt>86400000,
   rows:page.slice(0,50).map((r:StripeObject)=>({id:r.id,label:r.label,code:r.code,kind:r.kind||'subscription',status:r.status,paidThrough:r.paidThrough})),
   next:more?page[49].id:null};
 }
 /** Internal owner-scoped input for forecasts; independent of UI pagination. */
 incomeScope(owner:string){
  const c=this.settings(),p=this.profile(c.mode,owner);
  return {mode:c.mode,asOf:typeof p.referralStatusAt==='number'?p.referralStatusAt:null,
   rows:(Array.isArray(p.referralStatus)?p.referralStatus:[]).filter((r:StripeObject)=>r.owner===owner)
    .map((r:StripeObject)=>({id:String(r.id),kind:String(r.kind||'subscription'),status:String(r.status)}))};
 }
 /** Only metadata on six exact existing objects changes. Preflight every object
  * and local owner conflict before the first POST; repeat safely after a partial
  * network failure. This never creates a coupon, payout, or commission entry. */
 async inspectExistingOskarasOffers(owner:string){
  const c=this.settings();if(!c.enabled||c.mode!=='live')throw Error('Existing offers require enabled LIVE Earn');
  for(const spec of OSKARAS_EXISTING_OFFERS){const promo=await this.api('live').call('GET','/v1/promotion_codes/'+spec.promotion),coupon=await this.api('live').call('GET','/v1/coupons/'+spec.coupon,{'expand[0]':'applies_to'});verifyExistingOskaras(owner,promo,coupon,true);}
  for(const [other,p] of Object.entries(book(this.liveLedger.admin()).profiles))if(other!==owner&&(p as StripeObject).partnerPromotions?.some((x:StripeObject)=>OSKARAS_EXISTING_OFFERS.some(v=>v.promotion===x.promotion||v.code===x.code)))throw Error('Existing local offer belongs to another owner');
  return {offers:OSKARAS_EXISTING_OFFERS.length};
 }
 adoptExistingOskarasOffers(owner:string){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled||c.mode!=='live')throw Error('Existing offers require enabled LIVE Earn');
  const m=this.liveLedger.admin().members.find(x=>x.id===owner);if(!m)throw Error('Member not found');
  const api=this.api('live'),all=[];
  for(const spec of OSKARAS_EXISTING_OFFERS){
   const promo=await api.call('GET','/v1/promotion_codes/'+spec.promotion);
   const coupon=await api.call('GET','/v1/coupons/'+spec.coupon,{'expand[0]':'applies_to'});
   verifyExistingOskaras(owner,promo,coupon,true);all.push({spec,promo,coupon});
  }
  for(const [other,profile] of Object.entries(book(this.liveLedger.admin()).profiles)){
   if(other!==owner&&(profile as StripeObject).partnerPromotions?.some((x:StripeObject)=>OSKARAS_EXISTING_OFFERS.some(v=>v.promotion===x.promotion||v.code===x.code)))throw Error('Existing local offer belongs to another owner');
  }
  for(const {spec} of all){
   for(const [kind,objectId] of [['promotion_codes',spec.promotion],['coupons',spec.coupon]])
    await api.call('POST',`/v1/${kind}/${objectId}`,{'metadata[wh_earn_owner]':owner,'metadata[wh_earn_code]':spec.code},{key:'earn_adopt_'+hash(owner+objectId)});
  }
  const offers=[];
  for(const {spec} of all){
   const promo=await api.call('GET','/v1/promotion_codes/'+spec.promotion),coupon=await api.call('GET','/v1/coupons/'+spec.coupon,{'expand[0]':'applies_to'});
   verifyExistingOskaras(owner,promo,coupon);
   offers.push({...spec,products:[OSKARAS_EXISTING_PRODUCT],proof:{...spec,kind:OSKARAS_PROOF_KIND,owner,duration:'forever',products:[OSKARAS_EXISTING_PRODUCT],verifiedAt:this.now()}});
  }
  const prior=this.profile('live',owner),other=(prior.partnerPromotions||[]).filter((x:StripeObject)=>!OSKARAS_EXISTING_OFFERS.some(v=>v.code===x.code));
  this.updateProfile('live',owner,{partnerPromotions:[...other,...offers],partnerOffersUpdatedAt:this.now()});
  return {owner,offers};
 });}
 /** Explicit operator reconciliation of status only. Whole scan must finish;
  * partial scans never erase the prior snapshot. No invoice/payout replay. */
 refreshReferralStatus(owner:string){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earn is disabled');this.syncMember(c.mode,owner);
  const api=this.api(c.mode),rows:StripeObject[]=[];let cursor='';
  for(let page=0;page<100;page++){
   const batch=await api.call('GET','/v1/subscriptions',{status:'all',limit:100,'expand[0]':'data.discounts',...(cursor?{starting_after:cursor}:{})});
   if(!Array.isArray(batch.data)||typeof batch.has_more!=='boolean')throw Error('Incomplete referral subscription page');
   for(const sub of batch.data){
    const p=this.profile(c.mode,owner),allowed=[p.promotion,...(p.promotionHistory||[]).map((x:StripeObject)=>x.promotion),...(p.partnerPromotions||[]).map((x:StripeObject)=>x.promotion)].filter(Boolean);
    const ds=Array.isArray(sub.discounts)?sub.discounts:sub.discount?[sub.discount]:[];
    if(ds.length!==1||!allowed.includes(id(ds[0]?.promotion_code||ds[0]?.source?.promotion_code)))continue;
    const found=await this.appliedReferral(c.mode,sub);if(!found||found.owner!==owner)continue;
    if(typeof sub.id!=='string'||!sub.id.startsWith('sub_')||sub.livemode!==(c.mode==='live')||!id(sub.customer).startsWith('cus_'))throw Error('Incomplete referral subscription identity or mode');
    rows.push({owner,id:hash(owner+':'+sub.id),label:'Customer '+hash(owner+':'+id(sub.customer)).slice(0,8),code:found.offer.code,
     kind:'subscription',status:['active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(sub.status)?sub.status:'unknown',
     paidThrough:(book(this.ledger(c.mode).admin()).invoices as Record<string,Invoice>)?Object.values(book(this.ledger(c.mode).admin()).invoices as Record<string,Invoice>).filter(x=>x.owner===owner&&x.subscription===sub.id).reduce((v,x)=>Math.max(v,x.paidThrough||0),0)||null:null});
   }
   if(!batch.has_more){
    rows.push(...await this.oneTimeReferralStatuses(c.mode,owner));
    this.updateProfile(c.mode,owner,{referralStatus:rows,referralStatusAt:this.now()});return {count:rows.length};
   }
   const last=id(batch.data.at(-1));if(!last||last===cursor)throw Error('Invalid referral pagination');cursor=last;
  }
  throw Error('Referral status scan exceeded its finite page limit; previous snapshot retained');
 });}
 /** Complete Checkout redemptions are purchase facts, never subscription or
  * commission entries. The provider's applied promotion, configured one-time
  * software price/product, and settled payment chain must all agree. */
 private async oneTimeReferralStatuses(mode:BillingMode,owner:string){
  const api=this.api(mode),cfg=this.billing(),profile=this.profile(mode,owner),rows:StripeObject[]=[];
  const allowed=[profile.promotion,...(profile.promotionHistory||[]).map((x:StripeObject)=>x.promotion),...(profile.partnerPromotions||[]).map((x:StripeObject)=>x.promotion)].filter(Boolean);
  const plans=cfg.plans.filter(p=>p.role==='software'&&!p.interval&&p.checkout==='payment-link');
  const seen=new Set<string>();let cursor='';
  for(let page=0;page<100;page++){
   const batch=await api.call('GET','/v1/checkout/sessions',{status:'complete',limit:100,'expand[0]':'data.total_details.breakdown',...(cursor?{starting_after:cursor}:{})});
   if(!Array.isArray(batch.data)||typeof batch.has_more!=='boolean')throw Error('Incomplete referral Checkout page');
   for(const session of batch.data){
    const applied=(session.total_details?.breakdown?.discounts||[]).map((x:StripeObject)=>x.discount);
    const ds=applied.length?applied:Array.isArray(session.discounts)?session.discounts:[];
    if(ds.length!==1||!allowed.includes(id(ds[0]?.promotion_code||ds[0]?.source?.promotion_code)))continue;
    if(typeof session.id!=='string'||!session.id.startsWith('cs_')||seen.has(session.id)||session.livemode!==(mode==='live')||session.status!=='complete')throw Error('Incomplete or duplicate attributed Checkout identity');
    seen.add(session.id);
    if(session.payment_status!=='paid')continue; // An unpaid/expired attempt is not a redemption.
    if(!['payment','subscription'].includes(session.mode))throw Error('Unexpected attributed Checkout mode');
    const found=await this.appliedReferral(mode,{...session,discounts:ds});if(!found||found.owner!==owner)throw Error('Attributed Checkout owner could not be verified');
    const appliedCoupon=id(ds[0]?.coupon||ds[0]?.source?.coupon);if(appliedCoupon&&appliedCoupon!==found.offer.proof?.coupon)throw Error('Applied Checkout coupon disagrees with promotion proof');
    const items=await api.call('GET','/v1/checkout/sessions/'+session.id+'/line_items',{limit:100});
    if(!Array.isArray(items.data)||items.has_more!==false)throw Error('Incomplete attributed Checkout items');
    const software=items.data.map((item:StripeObject)=>({item,plan:plans.find(p=>cfg.stripe[mode].priceIds[p.key]===id(item.price))})).filter((x:StripeObject)=>x.plan);
    if(!software.length)continue; // Recurring-only checkout is already represented by its subscription.
    if(software.length!==1)throw Error('Ambiguous one-time software purchase');
    const {item,plan}=software[0];if(!plan)throw Error('One-time plan is unavailable');
    if(item.price?.type!=='one_time'||item.price?.recurring!=null||!found.offer.products.includes(id(item.price?.product))||item.quantity!==1||!Number.isSafeInteger(item.amount_discount)||item.amount_discount<=0||!Number.isSafeInteger(item.amount_subtotal)||item.amount_discount>item.amount_subtotal)throw Error('One-time software price, product or applied discount mismatch');
    let payment=id(session.payment_intent);
    if(session.mode==='subscription'){
     const invoice=id(session.invoice);if(!invoice.startsWith('in_'))throw Error('Mixed one-time purchase has no initial invoice');
     const inv=await api.call('GET','/v1/invoices/'+invoice);
     if(inv.id!==invoice||inv.livemode!==(mode==='live')||inv.status!=='paid'||id(inv.customer)!==id(session.customer)||id(inv.subscription||inv.parent?.subscription_details?.subscription)!==id(session.subscription)||!Number.isSafeInteger(session.amount_total)||session.amount_total<=0||inv.currency!==session.currency||inv.total!==session.amount_total||!Number.isSafeInteger(inv.amount_paid)||inv.amount_paid<session.amount_total)throw Error('Mixed purchase invoice identity or total mismatch');
     const payments=await api.call('GET','/v1/invoice_payments',{invoice,status:'paid',limit:100});
     if(payments.has_more!==false||!Array.isArray(payments.data)||payments.data.length!==1)throw Error('Mixed purchase payment chain is incomplete or ambiguous');
     const paid=payments.data[0];
     // A PaymentIntent can fund several invoices. Its overall charge cannot
     // substitute for the amount actually allocated to this initial invoice.
     if(!id(paid).startsWith('inpay_')||paid.invoice!==invoice||paid.livemode!==(mode==='live')||paid.status!=='paid'||paid.payment?.type!=='payment_intent'||paid.currency!==session.currency||!Number.isSafeInteger(paid.amount_paid)||paid.amount_paid!==session.amount_total)throw Error('Mixed purchase payment allocation mismatch');
     if(payment&&payment!==id(paid.payment.payment_intent))throw Error('Mixed Checkout payment disagrees with invoice allocation');
     payment=id(paid.payment.payment_intent);
    }
    if(!payment.startsWith('pi_'))throw Error('One-time purchase has no settled payment');
    const pi=await api.call('GET','/v1/payment_intents/'+payment,{'expand[0]':'latest_charge'}),charge=pi.latest_charge;
    if(pi.id!==payment||pi.livemode!==(mode==='live')||pi.status!=='succeeded'||id(pi.customer)!==id(session.customer)||!Number.isSafeInteger(session.amount_total)||session.amount_total<=0||!Number.isSafeInteger(pi.amount_received)||pi.amount_received<session.amount_total||pi.currency!==session.currency||!charge||typeof charge!=='object'||!id(charge).startsWith('ch_')||charge.livemode!==(mode==='live')||id(charge.payment_intent)!==payment||charge.paid!==true||id(charge.customer)!==id(session.customer)||charge.currency!==session.currency||!Number.isSafeInteger(charge.amount)||charge.amount<session.amount_total||!Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0||charge.amount_refunded>charge.amount||typeof charge.disputed!=='boolean')throw Error('One-time purchase payment or refund facts are incomplete');
    const status=charge.disputed?'disputed':charge.amount_refunded===charge.amount?'refunded':charge.amount_refunded>0?(session.mode==='subscription'?'refund_allocation_unknown':'partially_refunded'):'paid';
    rows.push({owner,id:hash(owner+':'+session.id),label:'Customer '+hash(owner+':'+(id(session.customer)||session.id)).slice(0,8),code:found.offer.code,kind:plan.lifetime?'lifetime':'one_time',status,paidThrough:null});
   }
   if(!batch.has_more)return rows;
   const last=id(batch.data.at(-1));if(!last||last===cursor)throw Error('Invalid Checkout pagination');cursor=last;
  }
  throw Error('Referral Checkout scan exceeded its finite page limit; previous snapshot retained');
 }
 private async verifyPromotion(mode:BillingMode,owner:string,promotion:string,code:string,percent:number,products:string[]){
  const api=this.api(mode),promo=await api.call('GET','/v1/promotion_codes/'+promotion),couponId=id(promo.coupon);
  if(promo.id!==promotion||promo.active!==true||promo.livemode!==(mode==='live')||String(promo.code||'').toUpperCase()!==code.toUpperCase()||promo.metadata?.managed_by!=='wh-earn'||promo.metadata?.wh_earn_owner!==owner||promo.expires_at!=null||promo.max_redemptions!=null||!couponId)throw Error('Stripe referral promotion could not be verified');
  const coupon=await api.call('GET','/v1/coupons/'+couponId,{'expand[0]':'applies_to'}),actual=couponProducts(coupon),expected=[...new Set(products)].sort();
  if(coupon.id!==couponId||coupon.valid!==true||coupon.percent_off!==percent||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn'||JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Stripe referral coupon does not match the recurring software offer');
  return {promotion,code,percent,duration:'forever',coupon:couponId,products:expected,verifiedAt:this.now()};
 }
 private async verifyHistoricalPromotion(mode:BillingMode,owner:string,promotion:string,code:string,products:string[]){
  const api=this.api(mode),promo=await api.call('GET','/v1/promotion_codes/'+promotion),couponId=id(promo.coupon);
  if(promo.id!==promotion||promo.livemode!==(mode==='live')||String(promo.code||'').toUpperCase()!==code.toUpperCase()||promo.metadata?.managed_by!=='wh-earn'||promo.metadata?.wh_earn_owner!==owner||!couponId)throw Error('Existing Stripe referral promotion could not be verified');
  const coupon=await api.call('GET','/v1/coupons/'+couponId,{'expand[0]':'applies_to'}),actual=couponProducts(coupon),expected=[...new Set(products)].sort();
  // This path preserves an offer already attached to an existing subscription;
  // Coupon.valid only controls new redemptions. Actual invoice attribution still
  // requires the matching promotion to be present on the subscription itself.
  if(coupon.id!==couponId||(coupon.valid!==true&&coupon.valid!==false)||!Number.isFinite(coupon.percent_off)||coupon.percent_off<=0||coupon.percent_off>100||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn'||JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Existing Stripe referral coupon is not a verified recurring software offer');
  return {promotion,code,percent:coupon.percent_off,duration:'forever',coupon:couponId,products:expected,verifiedAt:this.now()};
 }
 private offerForCode(mode:BillingMode,code:string){
  const members=this.liveLedger.admin().members,b=book(this.ledger(mode).admin());
  for(const [owner,value] of Object.entries(b.profiles)){
   const p=value as StripeObject,m=members.find(x=>x.id===owner);if(!m)continue;
   const offers=[...(p.promotion?[{code:p.code,promotion:p.promotion,percent:p.appliedDiscountPercent,products:p.products,proof:p.verifiedPromotion}]:[]),...(Array.isArray(p.partnerPromotions)?p.partnerPromotions:[])];
   const offer=offers.find((x:StripeObject)=>x.code===code&&x.promotion&&x.proof?.promotion===x.promotion&&x.proof?.duration==='forever'&&x.proof?.percent===x.percent);
   if(offer)return {owner,member:m,profile:p,offer};
   if(p.code===code||(Array.isArray(p.legacyCodes)&&p.legacyCodes.includes(code))||m.code===code){
    const standard=p.promotion?offers.find((x:StripeObject)=>x.code===p.code&&x.promotion===p.promotion&&x.proof?.promotion===x.promotion&&x.proof?.duration==='forever'&&x.proof?.percent===x.percent):undefined;
    if(standard)return {owner,member:m,profile:p,offer:standard};
   }
  }
  return null;
 }
 private async appliedReferral(mode:BillingMode,sub:StripeObject){
  const discounts=Array.isArray(sub.discounts)?sub.discounts:(sub.discount?[sub.discount]:[]);
  if(discounts.length!==1)return null; // Stripe Checkout allows one applied promotion; fail closed if a subscription was manually stacked.
  const applied=discounts[0],promotion=id(applied?.promotion_code||applied?.source?.promotion_code);if(!promotion)return null;
  const metadataCode=typeof sub.metadata?.wh_earn_code==='string'?sub.metadata.wh_earn_code:'';
  const members=this.liveLedger.admin().members,b=book(this.ledger(mode).admin());
  for(const [owner,value] of Object.entries(b.profiles)){
   const p=value as StripeObject,member=members.find(x=>x.id===owner);if(!member||metadataCode&&metadataCode!==member.code)continue;
   const candidates:StripeObject[]=[];
   if(p.promotion)candidates.push({promotion:p.promotion,code:p.code,percent:p.appliedDiscountPercent,products:p.products,proof:p.verifiedPromotion});
   if(Array.isArray(p.promotionHistory))candidates.push(...p.promotionHistory.map((row:StripeObject)=>({...row,proof:row.proof||row,history:true})));
   if(Array.isArray(p.partnerPromotions))candidates.push(...p.partnerPromotions);
   let offer=candidates.find(x=>x.promotion===promotion);
   // Old deployments stored legacy public codes but did not retain retired promo IDs.
   // Recover only when the actual Stripe discount points to a managed promo whose
   // customer-facing code is a locally recorded alias for this exact Earn owner.
   let promo:StripeObject;try{promo=await this.api(mode).call('GET','/v1/promotion_codes/'+promotion);}catch(error){
    // A genuinely absent promo with no local owner record is unrelated. Any
    // transport, rate-limit or server failure must escape so the durable
    // billing outbox can retry this invoice instead of permanently ignoring it.
    if(error instanceof EarnStripeError&&error.status===404&&error.code==='resource_missing'&&!offer)return null;
    throw error;
   }
   if(!offer){const actualCode=String(promo.code||'');if((p.code===actualCode||Array.isArray(p.legacyCodes)&&p.legacyCodes.includes(actualCode))&&promo.metadata?.wh_earn_owner===owner&&promo.metadata?.managed_by==='wh-earn')offer={promotion,code:actualCode,percent:Number(id(promo.coupon)?NaN:promo.coupon?.percent_off),products:p.products};}
   if(!offer)continue;
   if(offer.proof?.kind===OSKARAS_PROOF_KIND){
    if(mode!=='live'||offer.proof.owner!==owner)throw Error('Existing offer proof owner or mode mismatch');
    const coupon=await this.api(mode).call('GET','/v1/coupons/'+id(promo.coupon),{'expand[0]':'applies_to'});
    const exact=verifyExistingOskaras(owner,promo,coupon);
    if(offer.code!==exact.code||offer.percent!==exact.percent||offer.proof.coupon!==exact.coupon||offer.proof.promotion!==exact.promotion||JSON.stringify(offer.products)!==JSON.stringify([OSKARAS_EXISTING_PRODUCT])||JSON.stringify(offer.proof.products)!==JSON.stringify([OSKARAS_EXISTING_PRODUCT]))throw Error('Existing offer proof mismatch');
    return {owner,member,profile:p,offer};
   }
   if(promo.id!==promotion||promo.livemode!==(mode==='live')||promo.code!==offer.code||promo.metadata?.managed_by!=='wh-earn'||promo.metadata?.wh_earn_owner!==owner)throw Error('Registered Stripe referral promotion no longer matches its durable offer');
   const couponId=id(promo.coupon);if(!couponId)throw Error('Registered Stripe referral promotion has no coupon');
   // We have a candidate registered offer at this point. Failure to prove its
   // coupon is an operational review/retry condition, never proof the invoice was unrelated.
   const coupon:StripeObject=await this.api(mode).call('GET','/v1/coupons/'+couponId,{'expand[0]':'applies_to'});
   const products=couponProducts(coupon),expected=[...new Set((offer.products||[]).filter((x:unknown)=>typeof x==='string'))].sort();
   if(coupon.valid!==true&&coupon.valid!==false)throw Error('Stripe did not return coupon redemption validity for an attributed referral');
   if(coupon.id!==couponId||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn'||!Number.isFinite(coupon.percent_off)||coupon.percent_off<=0||coupon.percent_off>100||JSON.stringify(products)!==JSON.stringify(expected))throw Error('Registered Stripe referral coupon no longer matches its durable product offer');
   // Expiry/redemption caps block new checkout, but an existing forever
   // discount remains applied. Credit renewals only when durable proof matches
   // the exact coupon actually attached to the subscription.
   if(coupon.valid===false){
    const prior=offer.proof as StripeObject|undefined,priorProducts=Array.isArray(prior?.products)?[...new Set(prior.products.filter((x:unknown)=>typeof x==='string'))].sort():[];
    if(prior?.promotion!==promotion||prior?.code!==offer.code||prior?.coupon!==couponId||prior?.percent!==coupon.percent_off||prior?.duration!=='forever'||!Number.isFinite(prior?.verifiedAt)||JSON.stringify(priorProducts)!==JSON.stringify(products))throw Error('Applied Stripe coupon is no longer valid and has no matching durable offer proof; manual review is required');
   }
   if(Number.isFinite(offer.percent)&&coupon.percent_off!==offer.percent)throw Error('Registered Stripe referral coupon percentage no longer matches its durable offer');
   const proof={promotion,code:offer.code,percent:coupon.percent_off,duration:'forever',coupon:couponId,products,verifiedAt:this.now()};
   const saved=offer.proof;if(saved?.promotion!==promotion||saved?.coupon!==couponId||saved?.percent!==proof.percent||JSON.stringify(saved?.products)!==JSON.stringify(products)){
    if(p.promotion===promotion)this.updateProfile(mode,owner,{verifiedPromotion:proof,appliedDiscountPercent:proof.percent});
    else if(offer.history){const history=(Array.isArray(p.promotionHistory)?p.promotionHistory:[]).map((row:StripeObject)=>row.promotion===promotion?{...row,proof}:row);this.updateProfile(mode,owner,{promotionHistory:history});}
   }
   return {owner,member,profile:p,offer:{...offer,percent:proof.percent,proof}};
  }
  return null;
 }
 admin(){const c=this.settings();return {settings:c,payoutKeyConfigured:!!readJson<Partial<Record<BillingMode,string>>>(path.join(this.dir,'earn-stripe-secrets.v1.json'),{})[c.mode],lastError:this.lastError,...book(this.ledger(c.mode).admin())};}
 async readiness(){const c=this.settings();const accounts=await this.payoutApi(c.mode).call('GET','/v2/money_management/financial_accounts');return {mode:c.mode,accounts:(accounts.data||[]).map((a:StripeObject)=>({id:a.id,status:a.status,currencies:a.storage?.holds_currencies||[],availableUsd:a.balance?.available?.usd?.value??null}))};}
 activate(owner:string){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earnings are not enabled');const m=this.syncMember(c.mode,owner),p=this.profile(c.mode,owner);
  if(m.discountPercent===0){
   let priorProducts=Array.isArray(p.products)?p.products:[];if(p.promotion&&!priorProducts.length){const api=this.api(c.mode),plans=this.billing().plans.filter(plan=>plan.role==='software'&&plan.interval&&plan.checkout==='payment-link'&&plan.currency==='usd');for(const plan of plans){const priceId=this.billing().stripe[c.mode].priceIds[plan.key];if(!priceId)continue;const price=await api.call('GET','/v1/prices/'+priceId);if(price.active===true&&price.recurring?.interval===plan.interval&&price.currency==='usd')priorProducts.push(id(price.product));}}
   let priorProof=p.verifiedPromotion;if(p.promotion&&!priorProof){try{priorProof=await this.verifyHistoricalPromotion(c.mode,owner,String(p.promotion),String(p.code||m.code),priorProducts);}catch{/* Preserve the old offer as an unresolved history candidate; an applied but unprovable renewal must stay retryable for review. */}}
   if(p.promotion)await this.api(c.mode).call('POST','/v1/promotion_codes/'+p.promotion,{active:false},{key:'retire_'+p.promotion});
   const legacyCodes=[...new Set([...(Array.isArray(p.legacyCodes)?p.legacyCodes:[]),p.code].filter((v):v is string=>typeof v==='string'))];
   const promotionHistory=[...(Array.isArray(p.promotionHistory)?p.promotionHistory:[])];if(p.promotion&&!promotionHistory.some((x:StripeObject)=>x.promotion===p.promotion))promotionHistory.push(priorProof?{...priorProof}:{promotion:p.promotion,code:String(p.code||m.code),percent:p.appliedDiscountPercent,products:[...new Set(priorProducts)].sort(),proof:null});
   this.updateProfile(c.mode,owner,{code:m.code,promotion:null,signature:null,legacyCodes,promotionHistory,appliedDiscountPercent:0,verifiedPromotion:null,everActivated:!!p.promotion||p.everActivated===true});
   return this.view(owner);
  }
  const api=this.api(c.mode);
  const plans=this.billing().plans.filter(p=>p.role==='software'&&p.interval&&p.checkout==='payment-link'&&p.currency==='usd');
  const products:string[]=[];for(const plan of plans){const priceId=this.billing().stripe[c.mode].priceIds[plan.key];if(!priceId)continue;const price=await api.call('GET','/v1/prices/'+priceId);if(price.active===true&&price.recurring?.interval===plan.interval&&price.currency==='usd')products.push(id(price.product));}
  if(!products.length)throw Error('Create the recurring WH software plans in Stripe first');
  const uniqueProducts=[...new Set(products)].sort(),signature=hash(JSON.stringify([m.code,m.discountPercent,uniqueProducts]));if(p.signature===signature&&p.promotion){
   try { const proof=await this.verifyPromotion(c.mode,owner,String(p.promotion),String(p.code||m.code),m.discountPercent,uniqueProducts);
    this.updateProfile(c.mode,owner,{appliedDiscountPercent:m.discountPercent,products:uniqueProducts,verifiedPromotion:proof,everActivated:true});
   } catch(error) { this.updateProfile(c.mode,owner,{verifiedPromotion:null});throw error; }
   return this.view(owner);
  }
  if(m.discountPercent<1)throw Error('Referral discounts must be at least 1% to create a promotion code');
  const couponId='wh_earn_'+signature;
  let coupon:StripeObject;try{coupon=await api.call('GET','/v1/coupons/'+couponId,{'expand[0]':'applies_to'});}catch(e){if(!(e instanceof EarnStripeError)||e.status!==404)throw e;coupon=await api.call('POST','/v1/coupons',{id:couponId,duration:'forever',percent_off:m.discountPercent,'metadata[managed_by]':'wh-earn','expand[0]':'applies_to',...Object.fromEntries([...new Set(products)].map((v,i)=>[`applies_to[products][${i}]`,v]))},{key:couponId});}
  if(coupon.id!==couponId||coupon.valid!==true||coupon.percent_off!==m.discountPercent||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn'||JSON.stringify(couponProducts(coupon))!==JSON.stringify(uniqueProducts))throw Error('Existing Stripe coupon does not match this referral');
  // Changed discounts create a new public code; existing subscribers retain the discount they accepted.
  const code=p.promotion?m.code+signature.slice(0,6).toUpperCase():m.code;
  const existing=await api.call('GET','/v1/promotion_codes',{code,active:true,limit:100});let promo=(existing.data||[]).find((x:StripeObject)=>x.code?.toUpperCase()===code);
  if(promo && (id(promo.coupon)!==coupon.id||promo.metadata?.wh_earn_owner!==owner))throw Error('Referral code belongs to a different Stripe promotion');
  promo??=await api.call('POST','/v1/promotion_codes',{coupon:coupon.id,code,'metadata[wh_earn_owner]':owner,'metadata[managed_by]':'wh-earn'},{key:'promo_'+signature});
  if(!id(promo))throw Error('Stripe did not return a promotion code');
  const proof=await this.verifyPromotion(c.mode,owner,id(promo),code,m.discountPercent,uniqueProducts);
  let priorProof=p.verifiedPromotion;if(p.promotion&&!priorProof)priorProof=await this.verifyHistoricalPromotion(c.mode,owner,String(p.promotion),String(p.code||m.code),Array.isArray(p.products)&&p.products.length?p.products:uniqueProducts);
  if(p.promotion)await api.call('POST','/v1/promotion_codes/'+p.promotion,{active:false},{key:'retire_'+p.promotion});
  const legacyCodes=[...new Set([...(Array.isArray(p.legacyCodes)?p.legacyCodes:[]),p.code].filter((v):v is string=>typeof v==='string'&&v!==code))];
  const promotionHistory=[...(Array.isArray(p.promotionHistory)?p.promotionHistory:[])];if(p.promotion&&priorProof&&!promotionHistory.some((x:StripeObject)=>x.promotion===p.promotion))promotionHistory.push({...priorProof});
  this.updateProfile(c.mode,owner,{code,promotion:promo.id,signature,legacyCodes,promotionHistory,appliedDiscountPercent:m.discountPercent,products:uniqueProducts,verifiedPromotion:proof,everActivated:true});return this.view(owner);
 });}
 /** Registers the three reviewed Oskaras offers after an operator has matched
  * the supplied, verified email to an existing Earn member. This deliberately
  * cannot create or bind an owner: the waiting partner identity is unresolved. */
 registerOskarasOffers(owner:string){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earnings are not enabled');const m=this.syncMember(c.mode,owner),api=this.api(c.mode);
  const plans=this.billing().plans.filter(p=>p.role==='software'&&p.interval&&p.checkout==='payment-link'&&p.currency==='usd'),products:string[]=[];
  for(const plan of plans){const priceId=this.billing().stripe[c.mode].priceIds[plan.key];if(!priceId)continue;const price=await api.call('GET','/v1/prices/'+priceId);if(price.active===true&&price.recurring?.interval===plan.interval&&price.currency==='usd')products.push(id(price.product));}
  const uniqueProducts=[...new Set(products)].sort();if(!uniqueProducts.length)throw Error('Create the recurring WH software plans in Stripe first');
  const specs=[['OskarasTrading10K7',10],['OskarasTrading20M4',20],['OskarasTrading25R8',25]] as const,registered:StripeObject[]=[];
  for(const [code,percent] of specs){const signature=hash(JSON.stringify([owner,code,percent,uniqueProducts])),couponId='wh_osk_'+signature.slice(0,28);let coupon:StripeObject;
   try{coupon=await api.call('GET','/v1/coupons/'+couponId,{'expand[0]':'applies_to'});}catch(error){if(!(error instanceof EarnStripeError)||error.status!==404)throw error;coupon=await api.call('POST','/v1/coupons',{id:couponId,name:code,duration:'forever',percent_off:percent,'metadata[managed_by]':'wh-earn','metadata[wh_earn_owner]':owner,'metadata[wh_earn_code]':code,'expand[0]':'applies_to',...Object.fromEntries(uniqueProducts.map((v,i)=>[`applies_to[products][${i}]`,v]))},{key:couponId});}
   const couponProductScope=couponProducts(coupon);if(coupon.id!==couponId||coupon.valid!==true||coupon.percent_off!==percent||coupon.duration!=='forever'||coupon.metadata?.managed_by!=='wh-earn'||coupon.metadata?.wh_earn_owner!==owner||JSON.stringify(couponProductScope)!==JSON.stringify(uniqueProducts))throw Error(`Existing Stripe coupon for ${code} does not match the reviewed offer`);
   const listed=await api.call('GET','/v1/promotion_codes',{code,active:true,limit:100}),existing=(listed.data||[]).find((x:StripeObject)=>String(x.code||'').toUpperCase()===code.toUpperCase());let promo=existing;
   if(promo&&(id(promo.coupon)!==couponId||promo.metadata?.managed_by!=='wh-earn'||promo.metadata?.wh_earn_owner!==owner))throw Error(`Promotion code ${code} already belongs to another offer`);
   promo??=await api.call('POST','/v1/promotion_codes',{coupon:couponId,code,'metadata[managed_by]':'wh-earn','metadata[wh_earn_owner]':owner,'metadata[wh_earn_code]':code},{key:'wh_osk_'+signature});
   const proof=await this.verifyPromotion(c.mode,owner,id(promo),code,percent,uniqueProducts);registered.push({code,promotion:id(promo),percent,products:uniqueProducts,proof});
  }
  const prior=this.profile(c.mode,owner),byCode=new Map<string,StripeObject>();for(const row of [...(Array.isArray(prior.partnerPromotions)?prior.partnerPromotions:[]),...registered])byCode.set(String(row.code),row);
  this.updateProfile(c.mode,owner,{partnerPromotions:[...byCode.values()],partnerOffersUpdatedAt:this.now()});return {owner,offers:registered.map(({code,promotion,percent})=>({code,promotion,percent,duration:'forever'}))};
 });}
 launchReferral(code:string,mode:BillingMode){
  const c=this.settings();if(!c.enabled||c.mode!==mode)throw Error('Referrals are not available for this payment mode');
  const found=this.offerForCode(mode,code);if(!found)throw Error('Referral discount is not active');
  const {member,offer}=found,discount=offer.percent;
  if(!Number.isFinite(discount)||discount<=0||discount>100)throw Error('Referral discount is not active');
  return {code:member.code,promotionId:String(offer.promotion),discountPercent:Number(discount)};
 }
 checkout(code:string,planKey?:string|null){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Referrals are not available');const found=this.offerForCode(c.mode,code);if(!found)throw Error('Referral discount is not active');
  const {member:m,offer}=found,cfg=this.billing();const plan=cfg.plans.find(x=>x.key===(planKey||'monthly')&&x.role==='software'&&x.interval&&x.checkout==='payment-link'&&x.currency==='usd');const price=plan&&cfg.stripe[c.mode].priceIds[plan.key];if(!plan||!price)throw Error('This recurring subscription plan is unavailable');
  const r=await this.api(c.mode).call('POST','/v1/checkout/sessions',{mode:'subscription','line_items[0][price]':price,'line_items[0][quantity]':1,'discounts[0][promotion_code]':offer.promotion,'metadata[plan]':plan.key,'metadata[managed_by]':'wickhunter-hub','metadata[wh_earn_code]':m.code,'subscription_data[metadata][plan]':plan.key,'subscription_data[metadata][wh_earn_code]':m.code,'subscription_data[metadata][managed_by]':'wickhunter-hub',success_url:this.origin+'/customer?checkout=complete',cancel_url:this.origin+'/customer'},{key:'earn_checkout_'+randomUUID()});
  if(typeof r.url!=='string'||new URL(r.url).hostname!=='checkout.stripe.com')throw Error('Invalid Stripe checkout URL');return r.url;
 });}
 onboard(owner:string,input:Record<string,unknown>){return this.serial(async()=>{
  const c=this.settings();if(!c.enabled)throw Error('Earnings are not enabled');this.syncMember(c.mode,owner);const api=this.payoutApi(c.mode);let p=this.profile(c.mode,owner);
  if(!p.recipient){const country=String(input.country||'').toLowerCase(),email=String(input.email||'').trim().toLowerCase(),entity=String(input.entity||'individual'),network=String(input.network||'local');if(!/^[a-z]{2}$/.test(country)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!['individual','company'].includes(entity)||!['local','wire'].includes(network))throw Error('Enter your email, two-letter country code and account type');
   // Persist the exact creation request before the API call so retries reuse both key and body.
   if(!p.request){this.updateProfile(c.mode,owner,{request:{contact_email:email,identity:{country,entity_type:entity},configuration:{recipient:{capabilities:{bank_accounts:{[network]:{requested:true}}}}},metadata:{wh_earn_owner:owner},include:['configuration.recipient','requirements','identity']},requestAt:this.now()});p=this.profile(c.mode,owner);}
   if(this.now()-p.requestAt>23*3600000)throw Error('Recipient creation needs reconciliation before retrying; contact WH');
   const attempt=Number.isSafeInteger(p.requestAttempt)&&p.requestAttempt>=0?p.requestAttempt:0;
   const requestKey='earn_recipient_'+hash(c.mode+owner+(attempt?':'+attempt:''));
   let a:StripeObject;
   try { a=await api.call('POST','/v2/core/accounts',p.request,{key:requestKey}); }
   catch(error) {
    // A validation refusal has not created a recipient. Rotate the durable
    // idempotency key before accepting corrected facts. Transport, 409, 429,
    // and 5xx outcomes retain the exact original body/key for safe retry.
    if(error instanceof EarnStripeError && [400,422].includes(error.status)
      && !['idempotency_error','request_failed'].includes(error.code))
      this.updateProfile(c.mode,owner,{request:null,requestAt:null,requestAttempt:attempt+1});
    throw error;
   }
   if(!id(a).startsWith('acct_'))throw Error('Invalid Stripe recipient');this.updateProfile(c.mode,owner,{recipient:a.id,status:'onboarding'});p=this.profile(c.mode,owner);
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
  const ledger=this.ledger(mode),b=book(ledger.admin());if(b.seen[ev.id]||this.ignoredEvents(mode)[ev.id])return;
  // An unconfigured private program must not add Stripe dependencies to ordinary billing.
  if(!Object.values(b.profiles).some((p:any)=>p.promotion||(Array.isArray(p.promotionHistory)&&p.promotionHistory.length>0)||(Array.isArray(p.partnerPromotions)&&p.partnerPromotions.length>0))&&!Object.keys(b.invoices).length)return;
  const before=ledger.fileVersion(),api=this.api(mode),o=ev.object;
  if(['invoice.paid','invoice.payment_succeeded'].includes(ev.type))await this.invoice(mode,id(o));
  else if(ev.type.startsWith('customer.subscription.')){
   const state=ledger.admin(),tracked=state.referrals.find(r=>r.subscription===id(o));
   const statusOwners=Object.entries(book(state).profiles).filter(([owner,p])=>(p as StripeObject).referralStatus?.some((r:StripeObject)=>r.owner===owner&&r.id===hash(owner+':'+id(o)))).map(([owner])=>owner);
   if(tracked||statusOwners.length){
    const sub=await api.call('GET','/v1/subscriptions/'+id(o));
    if(id(sub)!==id(o))throw Error('Referral status subscription identity changed');
    ledger.transaction(s=>{
     const r=s.referrals.find(r=>r.subscription===sub.id);if(r)r.active=sub.status==='active'&&(Object.values(book(s).invoices) as Invoice[]).some(i=>i.subscription===sub.id&&i.paidThrough>this.now()&&!i.disputed&&i.refunded<i.paid);
     for(const owner of statusOwners){const row=book(s).profiles[owner]?.referralStatus?.find((r:StripeObject)=>r.owner===owner&&r.id===hash(owner+':'+sub.id));if(row){row.status=['active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(sub.status)?sub.status:'unknown';}}
    });
   }
  } else if(['charge.refunded','charge.dispute.created','charge.dispute.closed'].includes(ev.type)){
   const charge=ev.type==='charge.refunded'?id(o):id(o.charge);if(charge){const row=(Object.values(b.invoices) as Invoice[]).find(i=>i.charges.includes(charge));if(row)await this.adjustInvoice(mode,row.id);else{const ch=await api.call('GET','/v1/charges/'+charge);if(id(ch.invoice))await this.invoice(mode,id(ch.invoice));}}
  }
  // Foreign/untracked events must remain deduped, but recording their IDs in
  // the financial ledger would fsync its entire retained history for zero
  // financial change. An unrelated event goes in a bounded sidecar instead.
  if(ledger.fileVersion()===before&&Object.keys(b.seen).length<=SEEN_EVENT_MAX){this.rememberIgnoredEvent(mode,ev.id);return;}
  ledger.transaction(s=>{
   const seen=book(s).seen;seen[ev.id]=this.now();
   const keys=Object.keys(seen);
   if(keys.length>SEEN_EVENT_MAX){
    keys.sort((a,b)=>(Number(seen[a])||0)-(Number(seen[b])||0));
    for(const key of keys.slice(0,keys.length-SEEN_EVENT_MAX))delete seen[key];
   }
  });
 });}
 private hostedSoftwareBasis(mode:BillingMode,subscription:string,customer:string,sub:StripeObject,inv:StripeObject,offer:StripeObject):{software:number;hosting:number} {
  const metadata=sub.metadata||{},plan=String(metadata.plan||''),intentId=String(metadata.wh_launch_intent||'');
  if(metadata.bundle!=='software-hosting-v2'||!intentId||!['monthly','yearly'].includes(plan))throw Error('Mixed software/VPS subscription metadata is incomplete');
  if(sub.livemode!==(mode==='live')||id(sub.customer)!==customer)throw Error('Mixed subscription mode/customer differs from its invoice');
  const record=new BillingStore(this.dir).getBundleSubscription(subscription) as (StripeObject|null);
  if(!record||record.subscriptionId!==subscription||record.launchIntentId!==intentId||record.planKey!==plan||record.customerId!==customer||record.reservationId!==metadata.reservation)throw Error('Mixed subscription lacks its durable checkout binding');
  const grant=launchGrant(this.dir,{wh_launch_intent:intentId,plan},mode==='live') as (StripeObject|null);
  const hosting=grant?.hosting as (StripeObject|undefined);
  if(!grant||typeof grant.sessionId!=='string'||!/^cs_[A-Za-z0-9_]+$/.test(grant.sessionId)||!hosting||grant.mode!==mode||grant.plan!==plan||hosting.reservationId!==record.reservationId||
    grant.stripeParams['metadata[bundle]']!=='software-hosting-v2'||grant.stripeParams['metadata[reservation]']!==record.reservationId||
    grant.stripeParams['line_items[0][price]']!==hosting.softwarePriceId||grant.stripeParams['line_items[1][price]']!==hosting.hostingPriceId||
    hosting.softwareProductId===hosting.hostingProductId||hosting.hostingInterval!==(plan==='yearly'?'year':'month')||
    record.priceId!==hosting.softwarePriceId)throw Error('Mixed subscription differs from its persisted software/VPS offer');
  if(!Number.isSafeInteger(hosting.softwareAmountCents)||hosting.softwareAmountCents<=0||!Number.isSafeInteger(hosting.hostingAmountCents)||hosting.hostingAmountCents<=0||
    !Array.isArray(sub.items?.data)||sub.items.has_more||sub.items.data.length!==2)throw Error('Mixed subscription items are incomplete');
  const itemPrices=sub.items.data.map((item:StripeObject)=>id(item.price)).sort();
  if(JSON.stringify(itemPrices)!==JSON.stringify([hosting.softwarePriceId,hosting.hostingPriceId].sort())||sub.items.data.some((item:StripeObject)=>item.quantity!==1))throw Error('Mixed subscription items differ from the persisted offer');
  const lines=inv.lines?.data;
  if(!Array.isArray(lines)||inv.lines.has_more||lines.length!==2)throw Error('Mixed invoice line history is incomplete');
  const software=lines.filter((line:StripeObject)=>componentPriceId(line)===hosting.softwarePriceId),vps=lines.filter((line:StripeObject)=>componentPriceId(line)===hosting.hostingPriceId);
  if(software.length!==1||vps.length!==1||lines.some((line:StripeObject)=>!['software','hosting'].includes(componentPriceId(line)===hosting.softwarePriceId?'software':componentPriceId(line)===hosting.hostingPriceId?'hosting':''))||
    lines.some((line:StripeObject)=>line.quantity!==1))throw Error('Mixed invoice lines differ from the persisted offer');
  const softwareProduct=id(software[0].pricing?.price_details?.product)||id(software[0].price?.product);
  const hostingProduct=id(vps[0].pricing?.price_details?.product)||id(vps[0].price?.product);
  if((softwareProduct&&softwareProduct!==hosting.softwareProductId)||(hostingProduct&&hostingProduct!==hosting.hostingProductId))throw Error('Mixed invoice products differ from the persisted offer');
  const couponProducts=Array.isArray(offer.proof?.products)?offer.proof.products:[];
  if(!couponProducts.includes(hosting.softwareProductId)||couponProducts.includes(hosting.hostingProductId))throw Error('Applied referral does not cover only the software product');
  if(invoiceLineDiscount(vps[0])>0)throw Error('Referral discount unexpectedly applies to the VPS invoice line');
  const softwareNet=invoiceLineNet(software[0]),hostingNet=invoiceLineNet(vps[0]);
  if(hostingNet>hosting.hostingAmountCents||softwareNet<=0||softwareNet>hosting.softwareAmountCents)throw Error('Mixed invoice amounts differ from the persisted offer');
  return {software:softwareNet,hosting:hostingNet};
 }
 private async invoice(mode:BillingMode,invoiceId:string){
  const ledger=this.ledger(mode),api=this.api(mode);if(book(ledger.admin()).invoices[invoiceId]){await this.adjustInvoice(mode,invoiceId);return;}
  const inv=await api.call('GET','/v1/invoices/'+invoiceId,{'expand[0]':'payments.data.payment.payment_intent'});
  const subscription=id(inv.parent?.subscription_details?.subscription)||id(inv.subscription);if(!subscription||inv.status!=='paid'||inv.currency!=='usd'||inv.livemode!==(mode==='live'))return;
  const sub=await api.call('GET','/v1/subscriptions/'+subscription,{'expand[0]':'discounts'});
  const bundleRecord=new BillingStore(this.dir).getBundleSubscription(subscription) as (StripeObject|null);
  const mixed=sub.metadata?.bundle==='software-hosting-v2'||!!bundleRecord?.launchIntentId;
  // Lifetime software is a one-time purchase. Its recurring VPS invoice must
  // never create software referral commission.
  if(mixed&&(sub.metadata?.plan==='lifetime'||bundleRecord?.planKey==='lifetime'))return;
  const attribution=await this.appliedReferral(mode,sub);if(!attribution)return;
  const {member}=attribution;
  const cfg=this.billing(),allowed=new Set(cfg.plans.filter(p=>p.role==='software'&&p.interval&&p.checkout==='payment-link').map(p=>cfg.stripe[mode].priceIds[p.key]).filter(Boolean));
  const items=sub.items?.data||[];if(!items.length||sub.items?.has_more)return;
  const lines=inv.lines?.data||[];if(!lines.length||inv.lines?.has_more)return;
  const customerId=id(inv.customer);
  const mixedAmounts=mixed?this.hostedSoftwareBasis(mode,subscription,customerId,sub,inv,attribution.offer):null;
  const prices=[...new Set([...items.map((i:StripeObject)=>id(i.price)),...lines.map((l:StripeObject)=>id(l.pricing?.price_details?.price)||id(l.price))])];
  const historical=prices.filter(price=>price&&!allowed.has(price));
  if(!mixed&&(prices.some(price=>!price)||historical.length>4))return;
  if(!mixed&&historical.length){
   const products=new Set(Array.isArray(attribution.offer.proof?.products)?attribution.offer.proof.products.filter((v:unknown)=>typeof v==='string'):[]);
   if(!products.size)return; // Grandfathered prices must fit the exact product scope proved for this applied offer.
   for(const priceId of historical){
    const price=await api.call('GET','/v1/prices/'+priceId);
    if(!products.has(id(price.product))||price.currency!=='usd'||!['month','year'].includes(price.recurring?.interval))return;
   }
  }
  const cust=await api.call('GET','/v1/customers/'+customerId);
  // A changed customer email cannot turn the member's own subscription into
  // a payable referral. The durable binding is the authority when present;
  // the email check retains protection for older, unbound members.
  // One fresh read after remote customer truth covers both the payer binding
  // and all candidate referrer bindings; do not parse the full money ledger
  // again for every billing customer the server callback examines.
  const bindings=this.liveLedger.admin().ownerBindings??{};
  const billedOwner=boundOwnerFromBindings(bindings,[`stripe:${mode}:${customerId}`])
    ?? earnOwner('email:'+String(cust.email||'').trim().toLowerCase());
  if(billedOwner===member.id)return;
  // A second Stripe Customer can use a dotted/plus-tagged version of the
  // referrer's consumer Gmail inbox. Compare only with billing records already
  // bound to this immutable Earn owner; arbitrary customer emails, Workspace
  // domains and payment-method similarities are not identity evidence.
  const mailbox=consumerGmailMailbox(cust.email);
  if(mailbox && this.boundReferrerEmails?.(mode,member.id,bindings).some(email=>consumerGmailMailbox(email)===mailbox))return;
  const paid=money(inv.amount_paid);if(paid===null||paid===0)return;
  let basis:number;
  if(mixed){
   if(mixedAmounts===null)throw Error('Mixed invoice software basis is unavailable');
   const taxes=inv.total_taxes||inv.total_tax_amounts||[];if(!Array.isArray(taxes)||taxes.some((t:StripeObject)=>money(t.amount)===null))throw Error('Invoice tax total is unavailable');
   // Stripe can mark an invoice paid after applying a customer balance credit,
   // leaving amount_paid below the invoice total. Reserve tax and the entire
   // VPS component before attributing the remaining collected cash to software.
   const available=Math.max(0,paid-taxes.reduce((n:number,t:StripeObject)=>n+t.amount,0)-mixedAmounts.hosting);
   basis=Math.min(mixedAmounts.software,available);
  }
  else {
   const total=money(inv.total_excluding_tax);if(total===null)return;
   const taxes=inv.total_taxes||inv.total_tax_amounts||[];if(!Array.isArray(taxes)||taxes.some((t:StripeObject)=>money(t.amount)===null))throw Error('Invoice tax total is unavailable');
   basis=Math.min(total,Math.max(0,paid-taxes.reduce((n:number,t:StripeObject)=>n+t.amount,0)));
  }
  if(!basis)return;
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
  const c=this.settings();const mode=c.mode,ledger=this.ledger(mode);let jobs:Job[];
  // Reconcile even when automatic dispatch is paused. Submitted money still needs accounting.
  for(const rail of ['test','live'] as const){
   const own=this.ledger(rail),version=own.fileVersion(),memo=this.payoutScan[rail],at=this.now();
   // A new file (including another writer's atomic rename) forces a full scan.
   // Otherwise a posted-only book needs only a stat until its next six-hour
   // check. On restart the memo is empty, so every durable obligation is read.
   if(memo&&memo.version===version&&at<memo.nextDue)continue;
   const all=memo?.version===version?memo.jobs:book(own.admin()).jobs as Job[];
   const candidates=all.filter(j=>j.stripeId&&!j.identityConflict&&!['returned','failed','canceled'].includes(j.status)
    && (j.status!=='posted'||at-(j.checked||0)>=POSTED_RECHECK_MS)).sort((a,b)=>(a.checked||0)-(b.checked||0)).slice(0,100);
   const outcomes:{id:string;identity:string;status?:string;error?:unknown}[]=[];
   for(const job of candidates){const identity=payoutIdentity(job);try{outcomes.push({id:job.id,identity,status:await this.readPayoutStatus(rail,job)});}catch(error){outcomes.push({id:job.id,identity,error});}}
   let latest=all;
   if(outcomes.length)own.transactionIfChanged(s=>{
    const current=book(s).jobs as Job[];latest=current;let changed=false;
    for(const outcome of outcomes){const job=current.find(j=>j.id===outcome.id);if(!job)continue;
     if(payoutIdentity(job)!==outcome.identity){job.status='needs_review';job.identityConflict=true;job.error='Payout identity changed during reconciliation; manual review required';changed=true;continue;}
     if(outcome.error!==undefined){const message=outcome.error instanceof EarnStripeError?outcome.error.message:'Stripe could not be reached; reconciliation will retry';if(job.checked!==at||job.error!==message){job.checked=at;job.error=message;changed=true;}}
     else if(outcome.status!==undefined)try{changed=this.settleInState(s,job,outcome.status,at)||changed;}catch{
      const message='Payout ledger settlement needs review';if(job.checked!==at||job.error!==message){job.checked=at;job.error=message;changed=true;}
     }
    }
    return changed;
   });
   // Committed unknown submissions are obligations, independently of a new
   // admission switch, month, or member-selected destination. Reuse only the
   // durable body/key. Each mode gets a bounded, oldest-checked recovery batch
   // so one rail cannot starve the other, and the 26th job remains due.
   const recoverable=all.filter(j=>!j.stripeId&&j.status==='submitting'&&!j.identityConflict)
    .sort((a,b)=>(a.checked||0)-(b.checked||0)).slice(0,RECOVERY_JOB_LIMIT_PER_MODE);
   for(const job of recoverable)await this.submit(rail,job);
   if(recoverable.length)latest=book(own.admin()).jobs as Job[];
   // A 101st known-ID job remains due on the next tick, as do unresolved
   // submitting jobs. Only a posted/no-due or reviewed book may sleep.
   const nextDue=latest.reduce((due,j)=>j.identityConflict?due:j.stripeId&&!['returned','failed','canceled'].includes(j.status)
    ?Math.min(due,j.status==='posted'?(j.checked||0)+POSTED_RECHECK_MS:0):!j.stripeId&&j.status==='submitting'?0:due,Number.POSITIVE_INFINITY);
   this.payoutScan[rail]={version:own.fileVersion(),nextDue,jobs:latest};
  }
  if(!c.enabled||!c.automatic)return;
  const date=new Date(this.now());if(date.getUTCDate()<c.payoutDay)return;const cycle=date.toISOString().slice(0,7);
  // Admin configuration can change outside this serial worker while provider
  // requests await. Its snapshot authorizes only the same current settings;
  // already-committed recovery above remains independent of these switches.
  const admissionOpen=()=>{const fresh=this.settings(),at=new Date(this.now());return fresh.enabled&&fresh.automatic&&fresh.mode===mode&&fresh.financialAccount===c.financialAccount&&fresh.payoutDay===c.payoutDay&&at.getUTCDate()>=fresh.payoutDay&&at.toISOString().slice(0,7)===cycle;};
  const fa=await this.payoutApi(mode).call('GET','/v2/money_management/financial_accounts/'+c.financialAccount);if(!admissionOpen())return;if(fa.status!=='open'||fa.livemode!==(mode==='live'))throw Error('The payout financial account is not open in this mode');
  for(const m of ledger.admin().members){
   jobs=book(ledger.admin()).jobs as Job[];const old=jobs.find(j=>j.owner===m.id&&j.cycle===cycle);
   // The recovery pass owns existing submissions; do not retry one twice in
   // this run or bypass its recovery batch limit through new admission.
   if(old)continue;
   if(m.payoutPreference)continue;
   let recipient:string|null;try{recipient=await this.recipient(mode,m.id);}catch{continue;}if(!admissionOpen())return;if(!recipient)continue;
   const job=ledger.transaction(s=>{if(!admissionOpen())return null;const b=book(s);if(s.members.find(member=>member.id===m.id)?.payoutPreference||b.profiles[m.id]?.recipient!==recipient||b.jobs.some((j:Job)=>j.owner===m.id&&j.cycle===cycle))return null;
    const totals=sources.map(source=>({source,cents:s.entries.filter(e=>e.owner===m.id&&e.source===source).reduce((n,e)=>n+(e.period<cycle?e.cents:Math.min(0,e.cents)),0)}));
    // A debt in any program reduces the combined payable amount.
    let debt=-totals.filter(a=>a.cents<0).reduce((n,a)=>n+a.cents,0);const allocations=totals.filter(a=>a.cents>0).map(a=>{const offset=Math.min(a.cents,debt);debt-=offset;return {...a,cents:a.cents-offset};}).filter(a=>a.cents>0);const amount=allocations.reduce((n,a)=>n+a.cents,0);if(amount<1)return null;
    const job:Job={id:randomUUID(),owner:m.id,cycle,recipient:recipient!,financialAccount:c.financialAccount,amount,allocations,status:'submitting',created:this.now()};b.jobs.push(job);
    for(const a of allocations)s.entries.push(entry(m.id,a.source,'hold',-a.cents,'stripe:hold:'+job.id+':'+a.source,cycle,'Reserved for automatic Stripe payout',this.now()));return job;
   });if(job)await this.submit(mode,job);
  }
 });}
 private jobError(mode:BillingMode,jobId:string,error:unknown,expectedIdentity?:string){this.ledger(mode).transactionIfChanged(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===jobId);if(!j||j.identityConflict)return false;if(expectedIdentity&&payoutIdentity(j)!==expectedIdentity){j.status='needs_review';j.identityConflict=true;j.error='Payout identity changed during submission; manual review required';return true;}const at=this.now(),message=error instanceof EarnStripeError?error.message:'Stripe could not be reached; reconciliation will retry';if(j.checked===at&&j.error===message)return false;j.checked=at;j.error=message;return true;});}
 private async submit(mode:BillingMode,job:Job){
  const ledger=this.ledger(mode),identity=payoutIdentity(job),current=(book(ledger.admin()).jobs as Job[]).find(j=>j.id===job.id);
  if(!current||current.stripeId||current.status!=='submitting'||current.identityConflict)return;
  if(payoutIdentity(current)!==identity){ledger.transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===job.id)!;j.status='needs_review';j.identityConflict=true;j.error='Payout identity changed before recovery; manual review required';});return;}
  const age=this.now()-job.created;
  if(!Number.isSafeInteger(job.created)||age<0||age>23*3600000){ledger.transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===job.id)!;j.status='needs_review';j.error='Unknown submission outcome; reconcile in Stripe before releasing this reservation';});return;}
  let accepted=false,expected=identity;try{const result=await this.payoutApi(mode).call('POST','/v2/money_management/outbound_payments',{from:{financial_account:job.financialAccount,currency:'usd'},to:{recipient:job.recipient},amount:{value:job.amount,currency:'usd'},description:`Wick Hunter earnings ${job.cycle}`,metadata:{wh_payout_id:job.id}},{key:'wh_payout_'+job.id});if(!id(result))throw Error('Missing outbound payment ID');accepted=true;const stored=ledger.transaction(s=>{const j=(book(s).jobs as Job[]).find(j=>j.id===job.id)!;
   if(payoutIdentity(j)!==identity||j.status!=='submitting'){j.status='needs_review';j.identityConflict=true;j.error='Payout identity changed after submission; accepted Stripe payment requires manual review';j.stripeId??=result.id;return false;}
   j.stripeId=result.id;return true;});if(stored){expected=payoutIdentity({...job,stripeId:result.id});await this.reconcile(mode,{...job,stripeId:result.id});}}
  catch(e){this.jobError(mode,job.id,e,expected);if(!accepted&&e instanceof EarnStripeError&&[400,402,403,404,422].includes(e.status))this.settle(mode,job.id,'failed',expected);}
 }
 private async readPayoutStatus(mode:BillingMode,job:Job):Promise<string>{const result=await this.payoutApi(mode).call('GET','/v2/money_management/outbound_payments/'+job.stripeId);if(result.amount?.value!==job.amount||result.amount?.currency!=='usd'||id(result.to?.recipient)!==job.recipient||result.livemode!==(mode==='live'))throw Error('Stripe payout identity mismatch');return result.status;}
 private async reconcile(mode:BillingMode,job:Job){this.settle(mode,job.id,await this.readPayoutStatus(mode,job),payoutIdentity(job));}
 private settle(mode:BillingMode,jobId:string,status:string,expectedIdentity?:string){
  if(!['processing','posted','failed','canceled','returned'].includes(status))return;
  const at=this.now();this.ledger(mode).transactionIfChanged(s=>{const job=(book(s).jobs as Job[]).find(j=>j.id===jobId);if(!job)return false;if(expectedIdentity&&payoutIdentity(job)!==expectedIdentity){job.status='needs_review';job.identityConflict=true;job.error='Payout identity changed during reconciliation; manual review required';return true;}return this.settleInState(s,job,status,at);});
 }
 private settleInState(s:EarnState,job:Job,status:string,at:number):boolean{
   if(!['processing','posted','failed','canceled','returned'].includes(status)
     ||job.identityConflict||job.returned||(['failed','canceled'].includes(job.status)))return false;
   const originals=new Map<EarnSource,Entry>();
   if(['failed','canceled','returned'].includes(status)&&job.paid&&!job.returned)
    for(const a of job.allocations){const orig=s.entries.find(e=>e.reference==='stripe:payout:'+job.id+':'+a.source);
     if(!orig)throw Error('Payout reversal lacks its original paid entry');originals.set(a.source,orig);}
   const was=JSON.stringify(job);
   if(status==='posted'&&!job.paid){for(const a of job.allocations){s.entries.push(entry(job.owner,a.source,'release',a.cents,'stripe:release:'+job.id+':'+a.source,job.cycle,'Reservation settled by Stripe',this.now()));s.entries.push(entry(job.owner,a.source,'payout',-a.cents,'stripe:payout:'+job.id+':'+a.source,job.cycle,'Stripe payout sent (bank arrival may follow)',this.now()));}job.paid=true;job.released=true;}
   if(['failed','canceled','returned'].includes(status))for(const a of job.allocations){if(job.paid&&!job.returned){const reversal=entry(job.owner,a.source,'reversal',a.cents,'stripe:return:'+job.id+':'+a.source,job.cycle,'Stripe payout returned; earnings restored',this.now());reversal.reverses=originals.get(a.source)!.id;s.entries.push(reversal);}else if(!job.released)s.entries.push(entry(job.owner,a.source,'release',a.cents,'stripe:release:'+job.id+':'+a.source,job.cycle,'Stripe payout did not complete; earnings restored',this.now()));}
   if(['failed','canceled','returned'].includes(status)){job.released=true;job.returned=job.paid||status==='returned';}job.status=status;job.checked=at;if(status==='posted')delete job.error;
   return was!==JSON.stringify(job);
 }
}
