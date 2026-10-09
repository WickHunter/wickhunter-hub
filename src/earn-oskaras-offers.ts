import type {StripeObject} from './earn-stripe-api.js';
/** The operator-reviewed existing LIVE objects. This is not a general exemption
 * from managed referral or product-scope validation. Terms remain unchanged. */
export const OSKARAS_EXISTING_OFFERS = [
 {code:'OskarasTrading10K7',percent:10,promotion:'promo_1UNEW0KEy2hVxsezoEJ9xMzH',coupon:'wh_oskaras_25a082b8eb7e48524704fb21'},
 {code:'OskarasTrading20M4',percent:20,promotion:'promo_1UNEW1KEy2hVxsezvzDU88lx',coupon:'wh_oskaras_4bef9b115f79c6de711d74e5'},
 {code:'OskarasTrading25R8',percent:25,promotion:'promo_1UNEW2KEy2hVxsezfMGn1bOw',coupon:'wh_oskaras_723fb342e1378183489128b7'},
] as const;
export const OSKARAS_EXISTING_PRODUCT='prod_VGI40Usk9WlTQU';
export const OSKARAS_PROOF_KIND='existing-oskaras-scoped-v1';
export function verifyExistingOskaras(owner:string,promo:StripeObject,coupon:StripeObject,adopting=false) {
 const spec=OSKARAS_EXISTING_OFFERS.find(x=>x.promotion===promo.id);
 const couponId=typeof promo.coupon==='string'?promo.coupon:promo.coupon?.id;
 if(!spec||promo.livemode!==true||promo.code!==spec.code||couponId!==spec.coupon||coupon.id!==spec.coupon
   ||coupon.livemode!==true||coupon.percent_off!==spec.percent||coupon.duration!=='forever'
   ||coupon.amount_off!=null||JSON.stringify(coupon.applies_to?.products)!==JSON.stringify([OSKARAS_EXISTING_PRODUCT])||promo.expires_at!=null||promo.max_redemptions!=null
   ||promo.customer!=null||promo.restrictions?.first_time_transaction===true
   ||promo.restrictions?.minimum_amount!=null||coupon.max_redemptions!=null||coupon.redeem_by!=null
   ||promo.metadata?.managed_by!=null||coupon.metadata?.managed_by!=='wickhunter-hub'
   ||(adopting?(promo.active!==true||coupon.valid!==true):(typeof promo.active!=='boolean'||typeof coupon.valid!=='boolean')))
   throw Error('Existing Oskaras offer differs from the exact reviewed LIVE terms');
 for(const obj of [promo,coupon]){
  const bound=obj.metadata?.wh_earn_owner,code=obj.metadata?.wh_earn_code;
  if(adopting?((bound!=null&&bound!==owner)||(code!=null&&code!==spec.code)):(bound!==owner||code!==spec.code))
   throw Error('Existing Oskaras offer owner conflict');
 }
 return spec;
}
