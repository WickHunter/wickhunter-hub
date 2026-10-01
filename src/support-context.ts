import fs from 'node:fs';
import path from 'node:path';

export interface SupportGuideSection {
  id?: string;
  title?: string;
  text?: string;
  answer?: string;
  sourceId?: string;
  keywords?: string[];
  audience?: string;
  versionIndependent?: boolean;
}
interface SupportGuide { version?: string; sections?: SupportGuideSection[] }
function readGuide(file:string): SupportGuide | null {
  try { if (fs.statSync(file).size > 2 * 1024 * 1024) return null; const guide=JSON.parse(fs.readFileSync(file,'utf8')) as SupportGuide; return Array.isArray(guide.sections)?guide:null; } catch { return null; }
}
function guidesFor(file:string,version:string): {base:SupportGuide;current:SupportGuide} | null {
  const base=readGuide(file);if(!base)return null;
  if(version==='website'||base.version===version)return {base,current:base};
  if(!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))return {base,current:base};
  const exact=readGuide(path.join(path.dirname(file),'support-knowledge-'+version+'.json'));
  return {base,current:exact?.version===version?exact:base};
}

const STOP = new Set('a an and are as at be by can could do does for from have how i in is it me my of on or our the their them there these this to us was what when where which who why with would you your bot bots app wick hunter unleashed please help know tell about here mean'.split(' '));
const normalizedQuestion = (value:string) => value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const aliases: Record<string, string> = {
  cost: 'price', costs: 'price', pricing: 'price', priced: 'price', expensive: 'price', fees: 'price', fee: 'price', subscription: 'plan', subscriptions: 'plan', annual: 'yearly', buying: 'buy', purchase: 'buy', purchasing: 'buy', pay: 'buy', payment: 'buy', payments: 'buy', install: 'installation', installing: 'installation', installed: 'installation', setup: 'installation', deploy: 'installation', deployment: 'installation', host: 'hosting', hosted: 'hosting', server: 'hosting', vps: 'hosting', averaging: 'dca', average: 'dca', ladder: 'dca', ladders: 'dca',
};
export function supportTerms(value: string): string[] {
  const normalized = value.toLowerCase().replace(/dollar\s*[- ]?\s*cost\s*[- ]?\s*averaging/g, ' dca ').replace(/d\s*\.\s*c\s*\.\s*a\s*\.?/g, ' dca ');
  return [...new Set((normalized.match(/[a-z0-9]{3,}/g) || []).map(w => aliases[w] || w).filter(w => !STOP.has(w)))];
}
function score(section: SupportGuideSection, query: readonly string[]): number {
  const title = new Set(supportTerms(section.title || ''));
  const keywords = new Set(supportTerms((section.keywords || []).join(' ')));
  const answer = new Set(supportTerms(section.answer || ''));
  const body = new Set(supportTerms(section.text || ''));
  let total = 0, matches = 0;
  for (const term of query) {
    const points = title.has(term) ? 8 : keywords.has(term) ? 7 : answer.has(term) ? 5 : body.has(term) ? 1 : 0;
    if (points) { total += points; matches++; }
  }
  if (!matches) return 0;
  return total + matches * 2;
}
/** Only sections explicitly marked stable may cross a guide version boundary. */
export function selectSupportGuide(file: string | undefined, version: string, currentQuestion: string, previousCustomerQuestion = ''): string {
  if (!file) return '';
  const guides=guidesFor(file,version);if(!guides)return '';
  const {base,current:currentGuide}=guides;
  const current = supportTerms(currentQuestion);
  const followup = current.length <= 3 && /\b(it|that|those|they|them|there|this|what about|and|then|also)\b/i.test(currentQuestion);
  const prior = followup ? supportTerms(previousCustomerQuestion).filter(w => !current.includes(w)).slice(0, 5) : [];
  const sections=version==='website' ? base.sections! : currentGuide.version===version ? [
    ...currentGuide.sections!.filter(s=>s.audience!=='website'||s.versionIndependent===true),
    ...(currentGuide!==base?base.sections!.filter(s=>s.versionIndependent===true&&!currentGuide.sections!.some(c=>c.id===s.id)):[]),
  ] : base.sections!.filter(s=>s.versionIndependent===true);
  const candidates = sections
    .filter(s => typeof s?.text === 'string' && typeof s?.title === 'string')
    .filter(s => version !== 'website' || s.audience === 'website' || s.versionIndependent === true)
    .map(s => ({ section: s, rank: score(s, current) * 2 + score(s, prior) + (s.id === 'support-core-definitions' && (/\b(what is|what does|mean|is there|types? of|which bots?)\b/i.test(currentQuestion) || (current.includes('dca') && current.length===1)) ? 30 : 0) + (s.id === 'gd-number-input' && (/\b\d+[.,]\d+\b/.test(currentQuestion)||/\b(decimal|comma|numeric|number)\b/i.test(currentQuestion)) ? 60 : 0) + (s.id === 'support-new-bot-forms' && /\b(new|create|fresh|blank|empty|default|prefill\w*)\b/i.test(currentQuestion) && /\b(bot|form|hedge|setting)\b/i.test(currentQuestion) ? 100 : 0) }))
    .filter(x => x.rank >= 8)
    .sort((a, b) => b.rank - a.rank || String(a.section.id).localeCompare(String(b.section.id)));
  const selected: string[] = [];
  let remaining = 9000;
  for (const {section} of candidates.slice(0, 5)) {
    const body = section.answer?.trim() || section.text!.trim();
    const item = `[${section.sourceId || section.id || 'guide'}] ${section.title}\n${body.slice(0, 1700)}`;
    if (item.length > remaining) continue;
    selected.push(item); remaining -= item.length + 2;
  }
  return selected.join('\n\n');
}

interface BankQuestion {
  id?: string; topic?: string; question?: string; answer?: string; sourceIds?: string[];
  audience?: string; versionIndependent?: boolean; dynamicFacts?: string[];
  resolutionType?: 'direct' | 'dynamic' | 'clarify_human';
}
interface QuestionBank { version?: string; questions?: BankQuestion[]; items?: BankQuestion[]; sources?: {id?:string}[] | Record<string,unknown> }
/** Staff-reviewed question bank entries are candidate answers, never customer-written facts. */
export function selectSupportAnswers(guideFile: string | undefined, version: string, currentQuestion: string, previousCustomerQuestion = ''): string {
  if (!guideFile) return '';
  try {
    const bankFile = path.join(path.dirname(guideFile), 'support-question-bank.json');
    if (fs.statSync(bankFile).size > 4 * 1024 * 1024 || fs.statSync(guideFile).size > 2 * 1024 * 1024) return '';
    const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8')) as QuestionBank | BankQuestion[];
    const guides=guidesFor(guideFile,version);if(!guides)return '';
    const {base,current:currentGuide}=guides;
    const rows = Array.isArray(bank) ? bank : (bank.questions || bank.items || []);
    const bankVersion = Array.isArray(bank) ? base.version : bank.version || base.version;
    if (!Array.isArray(rows)) return '';
    const bankGuide=bankVersion?guidesFor(guideFile,bankVersion)?.current:base;
    // The bank is reviewed against its own guide snapshot. Older primary-guide
    // app sections cannot silently stand in for missing bank-version sections.
    const approvedSources = new Map(base.sections!.filter(s=>s.id && (s.versionIndependent === true || s.audience === 'website')).map(s=>[s.id!,s]));
    if(bankGuide && bankGuide.version===bankVersion)for(const section of bankGuide.sections!){if(section.id)approvedSources.set(section.id,section);}
    const currentSources = new Map(currentGuide.sections!.filter(s=>s.id).map(s=>[s.id!,s]));
    const manifestSources = Array.isArray(bank) ? new Set<string>() : new Set(Array.isArray(bank.sources) ? bank.sources.map(s=>s.id).filter((id):id is string=>typeof id==='string') : Object.keys(bank.sources || {}));
    const current = supportTerms(currentQuestion);
    const followup = current.length <= 3 && /\b(it|that|those|they|them|there|this|what about|and|then|also)\b/i.test(currentQuestion);
    const prior = followup ? supportTerms(previousCustomerQuestion).filter(w => !current.includes(w)).slice(0, 5) : [];
    const allowedDynamic = new Set(['software_price','plan_availability','offer_discount','offer_deadline','hosting_price','billing_status','crypto_plan_availability','lifetime_plan_availability']);
    const sourceEligible = (row:BankQuestion,id:string) => {
      const source=approvedSources.get(id);
      if (!source) return row.resolutionType === 'clarify_human' && manifestSources.has(id);
      if (version === 'website') return source.audience === 'website' || source.versionIndependent === true;
      if (source.audience === 'website') return source.versionIndependent === true && row.versionIndependent === true;
      if (bankVersion === version) return true;
      const exactSource=currentGuide.version===version?currentSources.get(id):undefined;
      if (exactSource && (exactSource.text!==source.text || exactSource.title!==source.title)) return false;
      return (exactSource?.text===source.text && exactSource?.title===source.title) || (source.versionIndependent === true && row.versionIndependent === true);
    };
    return rows.filter(row => row && typeof row.question === 'string' && typeof row.answer === 'string' && Array.isArray(row.sourceIds) && row.sourceIds.length > 0 && row.sourceIds.every(id => sourceEligible(row,id)))
      .filter(row => version === 'website' ? row.audience === 'website' || row.audience === 'both' : row.audience !== 'website' && (bankVersion === version || currentGuide.version === version || row.versionIndependent === true))
      .filter(row => row.resolutionType === 'direct' || row.resolutionType === 'dynamic' || row.resolutionType === 'clarify_human')
      .filter(row => row.resolutionType !== 'clarify_human' || normalizedQuestion(row.question || '') === normalizedQuestion(currentQuestion))
      .filter(row => row.resolutionType === 'clarify_human' || !row.dynamicFacts?.some(tag => !allowedDynamic.has(tag)))
      .map(row => ({row, rank: score({title:row.question, keywords:row.topic ? [row.topic] : [], text:''},current)*2 + score({title:row.question,text:''},prior) + (normalizedQuestion(row.question || '')===normalizedQuestion(currentQuestion)?1000:0)}))
      .filter(x => x.rank >= 8)
      .sort((a,b) => b.rank-a.rank || String(a.row.id).localeCompare(String(b.row.id)))
      .slice(0,3)
      .map(({row}) => JSON.stringify({id:row.id,question:row.question,answer:String(row.answer).slice(0,900),sourceIds:row.sourceIds,resolutionType:row.resolutionType,dynamicFacts:row.dynamicFacts || []}))
      .join('\n');
  } catch { return ''; }
}

interface PublicPlan { key?: unknown; name?: unknown; amountCents?: unknown; currency?: unknown; interval?: unknown; licenseDays?: unknown; lifetime?: unknown; description?: unknown; checkout?: unknown; buyUrl?: unknown; available?: unknown; discountedAmountCents?: unknown; cryptoAvailable?: unknown }
interface PublicCatalog { mode?: unknown; plans?: unknown; launch?: unknown }
/** The only pricing input is the public catalog already served to the site. */
export function supportPricingFacts(catalog: PublicCatalog | undefined, question: string, nowMs = Date.now()): string {
  const commerce=/\b(plans?|subscriptions?|monthly|yearly|annual|lifetime|discount|coupon|promo|offer codes?|cards?|payments?|checkout|charg\w*|renew\w*|billing|crypto|stablecoin|trial|free access|free period|free until)\b/i.test(question);
  const trading=/\b(dca|pairs?|entry|orders?|markets?|trades?|hedge|vwma|leverage|stops?|exchange|funding|candles?)\b/i.test(question);
  const price=/\b(pric\w*|cost\w*|how much)\b/i.test(question);
  const buy=/\b(buy|purchase)\b/i.test(question);
  const fee=/\bfees?\b/i.test(question)&&/\b(software|plans?|subscriptions?|hosting)\b/i.test(question);
  if (!commerce && !fee && !(price&&!trading) && !(buy&&!trading)) return '';
  if (!catalog || catalog.mode !== 'live' || !Array.isArray(catalog.plans)) return 'Current paid plan prices and availability could not be verified. Refer to the public pricing page or a human; do not quote a price.';
  const plans = catalog.plans.filter((p: PublicPlan) => p && typeof p.key === 'string' && !/host(?:ing|ed)/i.test(p.key) && typeof p.name === 'string' && Number.isSafeInteger(p.amountCents) && Number(p.amountCents) >= 0 && typeof p.currency === 'string').map((p: PublicPlan) => ({
    key: p.key, name: p.name, amountCents: p.amountCents, currency: p.currency, interval: p.interval, lifetime: p.lifetime === true, entitlement: p.lifetime === true ? 'Life of the product; valid technical license tokens renew automatically. The token duration is not a ten-year purchase term.' : undefined, description: p.description, checkout: p.checkout, buyUrl: p.buyUrl, available: p.available === true, discountedAmountCents: Number.isSafeInteger(p.discountedAmountCents) ? p.discountedAmountCents : undefined, cryptoAvailable: p.cryptoAvailable === true,
  }));
  const launch = catalog.launch && typeof catalog.launch === 'object' ? catalog.launch as Record<string, unknown> : {};
  const eastern=(ms:unknown)=>typeof ms==='number'&&Number.isFinite(ms)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(ms):undefined;
  return 'Current public billing catalog (amounts are minor currency units; availability refers to software Payment Links only): '+JSON.stringify({asOfEastern:eastern(nowMs),plans,launch:{active:launch.active === true,code:launch.active === true ? launch.code : undefined,discountPercent:launch.active === true ? launch.discountPercent : undefined,firstPaymentEastern:launch.active === true ? eastern(launch.firstPaymentAtMs) : undefined,redeemUntilEastern:launch.active === true ? eastern(launch.redeemUntilMs) : undefined,cryptoEnabled:launch.cryptoEnabled === true},recurringDiscountTerms:launch.active===true?'Eligible launch software subscriptions keep their approved discount on eligible active recurring renewals; optional hosting and VPS charges are excluded unless checkout says otherwise. Lifetime and eligible crypto purchases are one-time, not recurring.':undefined})+'. Quote public values accurately and distinguish checkout display from an actual individual charge. The first-payment date describes the active launch offer, not proof that this customer will be charged then. Do not promise personal eligibility or a successful checkout. Do not disclose account-specific billing status.';
}

interface HostingOptions { monthlyPriceLabel?: unknown; priceIsProposed?: unknown; regions?: unknown; planLabel?: unknown; maximumConnectedAccounts?: unknown; managedBackupsIncluded?: unknown; purchasable?: unknown; bundleEnabled?: unknown; bundles?: unknown }
export function supportHostingFacts(options: HostingOptions | undefined, question: string): string {
  if(!/\b(hosting|hosted|vps|managed server)\b/i.test(question))return '';
  if(!options)return 'Current hosting availability could not be verified; refer to the hosting checkout or a human.';
  const bundles=Array.isArray(options.bundles)?options.bundles.filter((b:any)=>b&&typeof b.key==='string'&&Number.isSafeInteger(b.amountCents)&&b.amountCents>=0&&typeof b.currency==='string').map((b:any)=>({key:b.key,interval:b.interval,amountCents:b.amountCents,currency:b.currency})):[];
  const regions=Array.isArray(options.regions)?options.regions.filter((r:any)=>r&&typeof r.label==='string').map((r:any)=>r.label.slice(0,60)).slice(0,10):[];
  return 'Current public hosting options (authority for hosting purchase availability; plan Payment Link availability does not control this checkout): '+JSON.stringify({monthlyPriceLabel:typeof options.monthlyPriceLabel==='string'?options.monthlyPriceLabel:undefined,priceIsProposed:options.priceIsProposed===true,regions,planLabel:typeof options.planLabel==='string'?options.planLabel.slice(0,100):undefined,maximumConnectedAccounts:Number.isSafeInteger(options.maximumConnectedAccounts)?options.maximumConnectedAccounts:undefined,managedBackupsIncluded:options.managedBackupsIncluded===true,purchasable:options.purchasable===true,bundleEnabled:options.bundleEnabled===true,bundles})+'. Do not say hosting is unavailable when purchasable or bundleEnabled is true; do not imply backups are included when false. Bundles combine software and hosting; check current checkout before promising an individual purchase.';
}
