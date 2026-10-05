#!/usr/bin/env node
// One-time operator entry point for the exact, user-approved Oskaras offers.
// It refuses to create an Earn owner: the email must already resolve to a
// verified/known member, and a second explicit confirmation is required.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { configFromEnv } from '../dist/src/config.js';
import { readBillingConfig } from '../dist/src/billing/config.js';
import { EarnService, earnOwner } from '../dist/src/earn.js';
import { EarnStripeService } from '../dist/src/earn-stripe.js';

const rl=readline.createInterface({input,output});
try {
  const email=(await rl.question('Verified Oskaras Earn account email: ')).trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('Enter a valid email supplied by the verified partner.');
  const cfg=configFromEnv(),ledger=new EarnService(cfg.dataDir),owner=earnOwner('email:'+email),member=ledger.admin().members.find(x=>x.id===owner);
  if(!member)throw Error('No existing Earn member matches this verified email. No account or owner binding was created.');
  const billing=readBillingConfig(cfg.dataDir),service=new EarnStripeService(cfg.dataDir,ledger,()=>billing,cfg.publicOrigin.replace(/\/+$/,''));
  const stripe=service.settings();if(!stripe.enabled)throw Error('Enable Earn Stripe referrals first.');
  const phrase=`APPLY ${stripe.mode.toUpperCase()} OSKARAS OFFERS`;
  output.write(`This will register OskarasTrading10K7 (10%), OskarasTrading20M4 (20%), and OskarasTrading25R8 (25%) for existing member “${member.name}” in Stripe ${stripe.mode}. Each discount is forever, recurring-software-only, reusable without a redemption cap, and has no expiry.\n`);
  if((await rl.question(`Type “${phrase}” to continue: `)).trim()!==phrase)throw Error('Confirmation did not match; no changes were made.');
  const result=await service.registerOskarasOffers(owner);
  output.write(`Registered ${result.offers.length} offers for Earn owner ${owner.slice(0,12)}… in ${stripe.mode}; no account binding or payout details were changed.\n`);
} catch(error) {
  output.write(`Offer setup stopped: ${error instanceof Error?error.message:'unexpected error'}\n`);
  process.exitCode=1;
} finally {rl.close();}
