/** Hub-owned earnings. Integer USD cents, immutable ledger entries and explicit
 * settlement references. No app-local balances, estimated trading profit or
 * implicit money movement. CSV imports are reviewed before commit. */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonfile.js';

export const EXCHANGES = [
  { id: 'bybit', name: 'Bybit', whPercent: 50, url: 'https://partner.bybit.com/b/WH' },
  { id: 'bitget', name: 'Bitget', whPercent: 50, url: 'https://partner.bitget.com/bg/0J4HKC' },
  { id: 'bitunix', name: 'Bitunix', whPercent: 50, url: 'https://www.bitunix.com/register?inviteCode=HFVMLK&t_act=-1' },
  { id: 'weex', name: 'WEEX', whPercent: 50, url: 'https://www.weex.com/en/register?vipCode=9fcy' },
];
export const BYBIT_HELP = 'https://www.bybit.com/en/help-center/article/How-to-Transfer-Your-Identity-to-Another-Account';
export type EarnSource = 'referral' | 'exchange' | 'marketplace';
type UID = { exchange: string; uid: string; verified: boolean; submittedAt: string };
type Member = { id: string; name: string; code: string; uids: UID[]; discountPercent: number; commissionPercent: number | null; rebatePercent: number; createdAt: string };
type Entry = { id: string; owner: string; source: EarnSource; kind: 'earning' | 'adjustment' | 'payout' | 'reversal'; cents: number; currency: 'USD'; period: string; reference: string; note: string; method: string; createdAt: string; actor: string; reverses?: string; paidAt?: string };
type Month = { period: string; digest: string; rows: { owner: string; commissionCents: number; rebateCents: number; qualified: boolean; rate: number }[] };
type State = { members: Member[]; entries: Entry[]; months: Month[]; audit?: { at: string; actor: string; owner: string; before: Member; after: Member }[]; referrals: { code: string; subscription: string; customer: string; active: boolean }[] };
export const earnOwner = (identity: string) => createHash('sha256').update(identity).digest('hex');
export const tierPercent = (active: number) => active <= 20 ? 20 : active <= 40 ? 30 : 40;
function text(v: unknown, max = 200): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f]/.test(v)) throw new Error('Invalid or missing text field'); return v.trim(); }
function percent(v: unknown): number { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) throw new Error('Percentage must be an integer from 0 to 100'); return v; }
function cents(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > 100_000_000) throw new Error('Amount must be integer USD cents, within $1,000,000'); return v; }
function period(v: unknown): string { if (typeof v !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(v)) throw new Error('Use a YYYY-MM period'); return v; }
function source(v: unknown): EarnSource { if (!['referral', 'exchange', 'marketplace'].includes(String(v))) throw new Error('Invalid earnings source'); return v as EarnSource; }
export function usdCents(v: string): number { if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) throw new Error('CSV commission_usd must be a nonnegative decimal, without currency symbols'); const [a,b=''] = v.split('.'); return cents(Number(a)*100 + Number(b.padEnd(2,'0'))); }
/** RFC-style quoted CSV; bounded by route and row count. */
export function csvRows(input: string): string[][] {
  if (typeof input !== 'string' || input.length > 1_000_000) throw new Error('CSV is too large');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, ended = false;
  for (let i=0;i<input.length;i++) { const c=input[i];
    if (quoted) { if(c==='"') { if(input[i+1]==='"') {cell+='"';i++;} else {quoted=false;ended=true;} } else cell+=c; continue; }
    if(c==='"' && cell==='' && !ended) {quoted=true;continue;}
    if(c===',' || c==='\n' || c==='\r') { row.push(cell.trim());cell='';ended=false; if(c!==',') { if(c==='\r' && input[i+1]==='\n')i++; if(row.some(Boolean))rows.push(row);row=[]; } }
    else { if(ended || c==='"')throw new Error('Malformed CSV quoting');cell+=c; }
    if(rows.length>5000)throw new Error('CSV has too many rows');
  }
  if(quoted)throw new Error('Unclosed CSV quote'); row.push(cell.trim());if(row.some(Boolean))rows.push(row);return rows;
}
export class EarnService {
  private file: string;
  constructor(dataDir: string, private now: () => number = Date.now) { this.file=path.join(dataDir,'earn.v1.json'); }
  private read(): State { return readJson(this.file,{members:[],entries:[],months:[],referrals:[]}); }
  private save(s: State) { writeJsonAtomic(this.file,s); }
  private date() { return new Date(this.now()).toISOString(); }
  member(owner: string, name: string) {
    const s=this.read(); let m=s.members.find(x=>x.id===owner);
    if(!m) {m={id:owner,name:name.slice(0,120),code:'WH'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase(),uids:[],discountPercent:10,commissionPercent:null,rebatePercent:50,createdAt:this.date()};s.members.push(m);this.save(s);}
    return m;
  }
  admin() { return this.read(); }
  view(owner: string, name: string) {
    const m=this.member(owner,name), s=this.read(), entries=s.entries.filter(e=>e.owner===owner);
    const active=s.referrals.filter(r=>r.code===m.code && r.active).length;
    return { member:m, activeSubscribers:active, commissionPercent:m.commissionPercent ?? tierPercent(active),
      exchanges:EXCHANGES, bybitHelp:BYBIT_HELP, minimumRebateCents:1500,
      balances:Object.fromEntries(['referral','exchange','marketplace'].map(src=>[src,entries.filter(e=>e.source===src).reduce((a,e)=>a+e.cents,0)])),
      paidCents: -entries.filter(e=>e.kind==='payout' || (e.kind==='reversal' && s.entries.find(o=>o.id===e.reverses)?.kind==='payout')).reduce((a,e)=>a+e.cents,0) || 0,
      entries:entries.slice().reverse(), months:s.months.flatMap(mo=>mo.rows.filter(r=>r.owner===owner).map(r=>({...r,period:mo.period}))) };
  }
  addUid(owner: string, input: Record<string,unknown>) {
    if(input.accountType !== 'main')throw new Error('Only main account UIDs are accepted; subaccounts are not eligible');
    const exchange=text(input.exchange,20), uid=text(input.uid,80);
    if(!EXCHANGES.some(e=>e.id===exchange)||!/^[A-Za-z0-9_-]{2,80}$/.test(uid))throw new Error('Enter a valid exchange UID');
    const s=this.read(), m=s.members.find(m=>m.id===owner);if(!m)throw new Error('Member not found');
    if(s.members.some(m=>m.uids.some(u=>u.exchange===exchange&&u.uid===uid)))throw new Error('That exchange UID is already registered; contact support if it is yours');
    if(m.uids.some(u=>u.exchange===exchange))throw new Error('A main account UID is already registered for this exchange; contact support to correct it');
    m.uids.push({exchange,uid,verified:false,submittedAt:this.date()});this.save(s);
  }
  configure(input: Record<string,unknown>) {
    const s=this.read(), m=s.members.find(m=>m.id===input.owner);if(!m)throw new Error('Member not found');
    const before=structuredClone(m);
    if(input.discountPercent!==undefined)m.discountPercent=percent(input.discountPercent);
    if(input.commissionPercent!==undefined)m.commissionPercent=input.commissionPercent===null?null:percent(input.commissionPercent);
    if(input.rebatePercent!==undefined)m.rebatePercent=percent(input.rebatePercent);
    if(input.exchange!==undefined) {const u=m.uids.find(u=>u.exchange===input.exchange && u.uid===input.uid);if(!u || typeof input.verified!=='boolean')throw new Error('UID not found');u.verified=input.verified;}
    (s.audit??=[]).push({at:this.date(),actor:'hub-admin',owner:m.id,before,after:structuredClone(m)});
    this.save(s);
  }
  record(input: Record<string,unknown>, actor='hub-admin') {
    const s=this.read(), owner=text(input.owner,100), src=source(input.source), kind=input.kind;
    if(!s.members.some(m=>m.id===owner))throw new Error('Member not found');
    if(!['earning','adjustment','payout'].includes(String(kind)))throw new Error('Invalid entry type');
    const amount=cents(input.cents), reference=text(input.reference), note=text(input.note,500), month=period(input.period);
    const method=kind==='payout'?text(input.method,80):'';
    const paidAt=kind==='payout'?text(input.paidAt,10):undefined;
    if(paidAt && (!/^20\d{2}-\d{2}-\d{2}$/.test(paidAt)||!Number.isFinite(Date.parse(paidAt))||new Date(paidAt).toISOString().slice(0,10)!==paidAt||paidAt>this.date().slice(0,10)))throw new Error('Enter the actual payout date, not a future date');
    if(amount===0 || ((kind==='earning'||kind==='payout')&&amount<0))throw new Error('Enter a positive amount');
    // Reference uniqueness spans manual payout methods and members: one settlement must not be paid twice.
    const prior=s.entries.find(e=>e.reference===reference && e.kind===kind);
    if(prior) {if(prior.owner===owner&&prior.source===src&&prior.cents===(kind==='payout'?-amount:amount)&&prior.period===month&&prior.note===note&&prior.method===method&&prior.paidAt===paidAt)return prior;throw new Error('Reference already used with different details');}
    const delta=kind==='payout'?-amount:amount, balance=s.entries.filter(e=>e.owner===owner&&e.source===src).reduce((a,e)=>a+e.cents,0);
    if(kind==='payout'&&balance<amount)throw new Error('Payout exceeds available earnings');
    const e:Entry={id:randomUUID(),owner,source:src,kind:kind as Entry['kind'],cents:delta,currency:'USD',period:month,reference,note,method,createdAt:this.date(),actor,...(paidAt?{paidAt}:{})};s.entries.push(e);this.save(s);return e;
  }
  reverse(input: Record<string,unknown>) {
    const s=this.read(), original=s.entries.find(e=>e.id===input.id);if(!original||original.kind==='reversal')throw new Error('Original entry not found');
    if(s.entries.some(e=>e.reverses===original.id))throw new Error('Entry already reversed');
    const e:Entry={...original,id:randomUUID(),kind:'reversal',cents:-original.cents,reference:'reverse:'+original.id,note:text(input.note,500),createdAt:this.date(),actor:'hub-admin',reverses:original.id};s.entries.push(e);this.save(s);return e;
  }
  previewCsv(input: Record<string,unknown>) {
    const month=period(input.period);if(month>=this.date().slice(0,7))throw new Error('Only completed months can be finalized');
    const rows=csvRows(String(input.csv??'').replace(/^\uFEFF/,''));
    if(rows.shift()?.join(',')!=='exchange,uid,commission_usd')throw new Error('CSV headers must be exchange,uid,commission_usd');
    if(!rows.length)throw new Error('CSV is empty');
    const s=this.read(), seen=new Set<string>(), totals=new Map<string,number>();
    for(const r of rows) {
      if(r.length!==3)throw new Error('Every CSV row must have three columns');const [exchange,uid,dollars]=r,key=exchange+':'+uid;
      if(seen.has(key))throw new Error('Duplicate exchange UID in CSV: '+key);seen.add(key);
      const m=s.members.find(m=>m.uids.some(u=>u.exchange===exchange&&u.uid===uid&&u.verified));
      if(!m)throw new Error('UID is unmatched or not verified: '+key);
      totals.set(m.id,cents((totals.get(m.id)??0)+usdCents(dollars)));
    }
    const result:Month={period:month,digest:'',rows:[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([owner,commissionCents])=>{const rate=s.members.find(m=>m.id===owner)!.rebatePercent;const rebateCents=Math.floor(commissionCents*rate/100);return {owner,commissionCents,rebateCents,qualified:rebateCents>=1500,rate};})};
    result.digest=createHash('sha256').update(JSON.stringify(result)).digest('hex');
    return {...result,alreadyImported:s.months.some(m=>m.period===month)};
  }
  importCsv(input: Record<string,unknown>) {
    const preview=this.previewCsv(input);if(input.digest!==preview.digest)throw new Error('Preview changed; review the CSV again');
    const s=this.read(), prior=s.months.find(m=>m.period===preview.period);
    if(prior) {if(prior.digest===preview.digest)return {duplicate:true};throw new Error('This month is already finalized. Use an audited adjustment to correct it');}
    const {alreadyImported,...month}=preview;
    for(const r of month.rows)if(r.qualified)s.entries.push({id:randomUUID(),owner:r.owner,source:'exchange',kind:'earning',cents:r.rebateCents,currency:'USD',period:month.period,reference:`rebate:${month.period}:${r.owner}`,note:`${r.rate}% of $${(r.commissionCents/100).toFixed(2)} commission received by WH`,method:'',createdAt:this.date(),actor:'hub-admin'});
    // Sub-$15 totals are recorded for transparency, never carried to a later month.
    s.months.push(month);this.save(s);return {duplicate:false};
  }
}
