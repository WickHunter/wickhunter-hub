/** Explicit API versions; credentials never leave api.stripe.com or enter errors. */
export type StripeObject = Record<string, any>;
export class EarnStripeError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Stripe request failed (${status}, ${code})`); }
}
export class EarnStripeApi {
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
  async call(method: 'GET'|'POST', endpoint: string, body: StripeObject = {}, options: { key?: string; context?: string } = {}): Promise<StripeObject> {
    if (!/^\/v[12]\/[A-Za-z0-9_/]+$/.test(endpoint)) throw Error('Invalid Stripe endpoint');
    const v2=endpoint.startsWith('/v2/');
    const headers: Record<string,string>={authorization:`Bearer ${this.key}`,'Stripe-Version':v2?'2026-08-26.preview':'2025-03-31.basil'};
    if(options.key)headers['Idempotency-Key']=options.key;
    if(options.context)headers['Stripe-Context']=options.context;
    const params=new URLSearchParams(Object.entries(body).map(([k,v])=>[k,String(v)]));
    let url='https://api.stripe.com'+endpoint;
    if(method==='GET' && params.size)url+='?'+params.toString();
    if(method==='POST')headers['content-type']=v2?'application/json':'application/x-www-form-urlencoded';
    for(let attempt=0;;attempt++) {
      try {
        const res=await this.fetcher(url,{method,headers,redirect:'error',signal:AbortSignal.timeout(15_000),...(method==='POST'?{body:v2?JSON.stringify(body):params.toString()}:{})});
        const data=await res.json() as StripeObject;
        if(!res.ok)throw new EarnStripeError(res.status,String(data.error?.code||'request_failed').replace(/[^a-zA-Z0-9_]/g,'').slice(0,80));
        return data;
      } catch(error) {
        // A complete referral scan can contain many provider reads. Retry one
        // transient transport failure at the same bounded endpoint; never
        // replay a payment/payout write or treat missing evidence as empty.
        const e=error as {name?:string;cause?:{code?:string}};
        const transient=e?.name==='TimeoutError' || e?.name==='AbortError'
          || ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(e?.cause?.code||'');
        if(method!=='GET' || attempt!==0 || !transient)throw error;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
  }
}
