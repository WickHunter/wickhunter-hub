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
    .map(s => ({ section: s, rank: score(s, current) * 2 + score(s, prior) + (/\b(what is|what does|mean|is there|types? of)\b/i.test(currentQuestion) && s.id === 'support-core-definitions' ? 30 : 0) }))
    .filter(x => x.rank > 0)
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
    const approvedSources = new Map(base.sections!.filter(s=>s.id).map(s=>[s.id!,s]));
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
      return (exactSource?.text===source.text && exactSource?.title===source.title) || (source.versionIndependent === true && row.versionIndependent === true);
    };
    return rows.filter(row => row && typeof row.question === 'string' && typeof row.answer === 'string' && Array.isArray(row.sourceIds) && row.sourceIds.length > 0 && row.sourceIds.every(id => sourceEligible(row,id)))
      .filter(row => version === 'website' ? row.audience === 'website' || row.audience === 'both' : row.audience !== 'website' && (bankVersion === version || currentGuide.version === version || row.versionIndependent === true))
      .filter(row => row.resolutionType === 'direct' || row.resolutionType === 'dynamic' || row.resolutionType === 'clarify_human')
      .filter(row => row.resolutionType !== 'clarify_human' || normalizedQuestion(row.question || '') === normalizedQuestion(currentQuestion))
      .filter(row => row.resolutionType === 'clarify_human' || !row.dynamicFacts?.some(tag => !allowedDynamic.has(tag)))
      .map(row => ({row, rank: score({title:row.question, keywords:row.topic ? [row.topic] : [], text:''},current)*2 + score({title:row.question,text:''},prior)}))
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
export function supportPricingFacts(catalog: PublicCatalog | undefined, question: string): string {
  if (!/\b(pric\w*|cost\w*|fees?|plans?|subscriptions?|monthly|yearly|annual|lifetime|buy|purchase|discount|coupon|promo)\b/i.test(question)) return '';
  if (!catalog || catalog.mode !== 'live' || !Array.isArray(catalog.plans)) return 'Current paid plan prices and availability could not be verified. Refer to the public pricing page or a human; do not quote a price.';
  const plans = catalog.plans.filter((p: PublicPlan) => p && typeof p.key === 'string' && typeof p.name === 'string' && Number.isSafeInteger(p.amountCents) && Number(p.amountCents) >= 0 && typeof p.currency === 'string').map((p: PublicPlan) => ({
    key: p.key, name: p.name, amountCents: p.amountCents, currency: p.currency, interval: p.interval, licenseDays: p.licenseDays, lifetime: p.lifetime === true, description: p.description, checkout: p.checkout, buyUrl: p.buyUrl, available: p.available === true, discountedAmountCents: Number.isSafeInteger(p.discountedAmountCents) ? p.discountedAmountCents : undefined, cryptoAvailable: p.cryptoAvailable === true,
  }));
  const launch = catalog.launch && typeof catalog.launch === 'object' ? catalog.launch as Record<string, unknown> : {};
  return 'Current public billing catalog (amounts are minor currency units; availability refers to the public checkout link): '+JSON.stringify({plans,launch:{active:launch.active === true,code:launch.active === true ? launch.code : undefined,discountPercent:launch.active === true ? launch.discountPercent : undefined,firstPaymentAtMs:launch.active === true ? launch.firstPaymentAtMs : undefined,redeemUntilMs:launch.active === true ? launch.redeemUntilMs : undefined,cryptoEnabled:launch.cryptoEnabled === true}})+'. Quote only these public values, convert cents accurately, and distinguish available checkout from listed price. A displayed launch discount is conditional; do not promise individual eligibility or a successful checkout. Do not disclose an account-specific entitlement.';
}
