import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/Users/zloren/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'].filter(Boolean)) {
  try { playwright = await import(candidate); break; } catch {}
}
if (!playwright?.chromium) {
  console.log('Admin launch UI: skipped (Playwright runtime unavailable; set PLAYWRIGHT_MODULE to bundled Playwright)');
  process.exit(0);
}

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  if (req.url === '/admin' || req.url === '/admin/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
  }
  res.writeHead(404); res.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const calls = [];
let prepared = false, offerEnabled = false, cryptoEnabled = false;
let notificationSaved;
const kinds = { signup:true, renewal:true, discount:true, paymentFailed:true, supportNew:true, supportHuman:true, supportReply:true, supportResolved:true };
const report = {
  ok:true, activeMode:'test', generatedAtMs:Date.UTC(2026,8,30,16), refreshing:false,
  byMode:{
    test:{ activeRecurring:2, scheduledPrelaunchStarts:1, oneTimePurchases:{yearly:3,lifetime:1}, mrrMinorByCurrency:{usd:4368.75}, scheduledMrrMinorByCurrency:{usd:2499}, unknownAmountCount:0, refreshedAtMs:Date.UTC(2026,8,30,15), refreshError:null,
      subscriptions:[
        {plan:'yearly',status:'active',cancelAtPeriodEnd:false,currentPeriodEndMs:Date.UTC(2026,9,15),discountPercent:25,currency:'usd',netMrrMinor:4368.75,linesKnown:true},
        {plan:'invalid-null',status:'active',currentPeriodEndMs:Date.UTC(2026,9,15),discountPercent:0,currency:'usd',netMrrMinor:null,linesKnown:true},
        {plan:'invalid-string',status:'active',currentPeriodEndMs:Date.UTC(2026,9,15),discountPercent:0,currency:'usd',netMrrMinor:'4368.75',linesKnown:true},
      ] },
    live:{ activeRecurring:0, scheduledPrelaunchStarts:0, oneTimePurchases:{yearly:0,lifetime:0}, mrrMinorByCurrency:{}, scheduledMrrMinorByCurrency:{}, unknownAmountCount:0, refreshedAtMs:null, refreshError:null, subscriptions:[] },
  }, reminders:{running:true,counts:{pending:1,sent:4,canceled:0,needs_attention:0},needsAttention:[]},
};
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await playwright.chromium.launch({ headless:true, ...(fs.existsSync(chrome) ? { executablePath:chrome } : {}) });
try {
  const page = await browser.newPage({ viewport:{width:390,height:844}, colorScheme:'light' });
  await page.route('**/admin/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = request.headers();
    calls.push({ pathname, method:request.method(), headers, body:request.postData() });
    let status = 200, body = { ok:true };
    if (request.method() !== 'GET') {
      assert.equal(headers['x-hub-admin'], 'ui-test-token', 'all admin writes include the entered token');
      assert.equal(headers['x-hub-csrf'], 'marketplace-config-v1', 'all admin writes keep CSRF protection');
    }
    if (pathname.endsWith('/api/health')) body = { ok:true, version:'test' };
    else if (pathname.endsWith('/api/billing/config')) { status=404; body={ok:false,error:'not configured'}; }
    else if (pathname.endsWith('/api/billing/customers')) body={ok:true,customers:[]};
    else if (pathname.endsWith('/api/billing/events')) body={ok:true,events:[]};
    else if (pathname.endsWith('/api/billing/launch') && request.method()==='GET') body={ok:true,mode:'test',enabled:offerEnabled,prepared,cryptoEnabled,active:offerEnabled,code:'UNLEASHED25',discountPercent:25,firstPaymentAtMs:Date.UTC(2026,9,15,4),redeemUntilMs:Date.UTC(2026,9,16,4)};
    else if (pathname.endsWith('/api/billing/launch') && request.method()==='POST') {
      const input=request.postDataJSON();
      if (input.action==='prepare') prepared=true;
      else { offerEnabled=input.enabled; cryptoEnabled=input.cryptoEnabled; }
      body={ok:true,mode:'test',enabled:offerEnabled,prepared,cryptoEnabled,active:offerEnabled,code:'UNLEASHED25',discountPercent:25,firstPaymentAtMs:Date.UTC(2026,9,15,4),redeemUntilMs:Date.UTC(2026,9,16,4)};
    } else if (pathname.endsWith('/api/billing/report/refresh')) { status=202; body={ok:true,refreshing:true}; }
    else if (pathname.endsWith('/api/billing/report')) body=report;
    else if (pathname.endsWith('/api/notifications') && request.method()==='GET') body={ok:true,configured:true,enabledKinds:{...kinds},counts:{queued:1,sending:0,delivered:5,failed:0,ambiguous:0},recent:[]};
    else if (pathname.endsWith('/api/notifications') && request.method()==='POST') {
      notificationSaved=request.postDataJSON();
      Object.assign(kinds,notificationSaved.enabledKinds);
      body={ok:true,configured:true,enabledKinds:{...kinds},counts:{queued:1,sending:0,delivered:5,failed:0,ambiguous:0},recent:[]};
    }
    else if (pathname.endsWith('/api/marketing/brevo/test')) body={ok:true,configured:true,webhookConfigured:true,listIds:[4,12],lastTestAt:'2026-09-30T16:00:00.000Z',lastTestOk:true,lastTestMessage:'Account reachable'};
    else if (pathname.endsWith('/api/marketing/brevo') && request.method()==='GET') body={ok:true,configured:true,webhookConfigured:true,listIds:[4,12],lastTestAt:null,lastTestOk:null,lastTestMessage:''};
    else if (pathname.endsWith('/api/marketing/brevo') && request.method()==='POST') body={ok:true,configured:true,webhookConfigured:true,listIds:[4,12],lastTestAt:null,lastTestOk:null,lastTestMessage:''};
    await route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${address.port}/admin`);
  await page.evaluate(async () => { token='ui-test-token'; document.getElementById('gate').hidden=true; showHubPage('billing',false); await loadHubPage('billing',true); });
  await page.getByRole('heading', {name:'Launch offer', exact:true}).waitFor();
  await page.locator('#launchOfferFacts').waitFor();
  assert.match(await page.locator('#launchOfferFacts').innerText(), /UNLEASHED25/);
  assert.match(await page.locator('#launchOfferFacts').innerText(), /Oct 15/);
  assert.match(await page.locator('#billingReportModes').innerText(), /\$43\.69/);
  assert.match(await page.locator('#briefRevenueNote').innerText(), /\$43\.69 \/ month/);
  const subscriptionRows = await page.locator('#billingSubscriptions tbody tr').allInnerTexts();
  assert.match(subscriptionRows[0], /yearly.*\$43\.69/);
  assert.match(subscriptionRows[1], /invalid-null.*Unknown/);
  assert.match(subscriptionRows[2], /invalid-string.*Unknown/);
  assert.deepEqual(await page.evaluate(() => [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1].map(n => minorCurrency(n, 'usd'))),
    ['Unknown','Unknown','Unknown','Unknown']);
  assert.match(await page.locator('#billingReminderHealth').innerText(), /Worker\s+Processing/);
  assert.match(await page.locator('#billingReportPanel').innerText(), /Separately billed VPS subscriptions are excluded/);
  assert.equal(await page.locator('#notificationWebhook').inputValue(), '', 'saved webhook URL is never returned to the UI');
  assert.equal(await page.locator('#notificationSettingsPanel button').filter({hasText:/test message/i}).count(), 0, 'there is no arbitrary notification test sender');
  assert.equal(await page.getByRole('button', {name:/publish/i}).count(), 0, 'no release publishing action is exposed');
  assert.equal(await page.locator('details.admin-advanced:not([open])').count(), 3, 'advanced billing, customer records and marketing setup start collapsed');
  assert.ok(await page.locator('#billingProvisionLive').count(), 'existing Live provisioning control remains in advanced settings');

  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name:'Prepare Stripe offer'}).click();
  await page.locator('#launchEnabled').check();
  await page.locator('#launchCryptoEnabled').check();
  await page.getByRole('button', {name:'Save offer settings'}).click();
  assert.ok(calls.some(c => c.pathname.endsWith('/api/billing/launch') && c.method==='POST' && JSON.parse(c.body).action==='prepare'));
  assert.ok(calls.some(c => c.pathname.endsWith('/api/billing/launch') && c.method==='POST' && JSON.parse(c.body).enabled===true && JSON.parse(c.body).cryptoEnabled===true));

  await page.locator('#notificationWebhook').fill('https://discord.com/api/webhooks/12345678901234567/' + 'a'.repeat(50));
  await page.locator('[data-notification-kind="renewal"]').uncheck();
  await page.getByRole('button', {name:'Save notification settings'}).click();
  await page.waitForFunction(()=>document.getElementById('notificationSaveNote').textContent==='Notification settings saved.');
  assert.equal(notificationSaved.webhookUrl, 'https://discord.com/api/webhooks/12345678901234567/' + 'a'.repeat(50));
  assert.equal(notificationSaved.enabledKinds.renewal, false);
  assert.equal(await page.locator('#notificationWebhook').inputValue(), '', 'the submitted write-only URL is cleared after save');
  assert.ok(calls.filter(c=>c.method==='POST').every(c=>c.headers['x-hub-csrf']==='marketplace-config-v1'));

  await page.locator('#marketingSettingsPanel > summary').click();
  await page.locator('#marketingBrevoLists').fill('4, 12');
  await page.locator('#marketingBrevoKey').fill('write-only-api-key');
  await page.getByRole('button', {name:'Save Brevo settings'}).click();
  const brevoPost=calls.find(c=>c.pathname.endsWith('/api/marketing/brevo') && c.method==='POST');
  assert.deepEqual(JSON.parse(brevoPost.body), {apiKey:'write-only-api-key',listIds:[4,12]}, 'Brevo update omits the blank webhook secret to retain it');
  await page.getByRole('button', {name:'Check Brevo connection'}).click();
  await page.waitForFunction(()=>document.getElementById('marketingBrevoStatus').textContent.includes('Account reachable'));
  assert.ok(calls.some(c=>c.pathname.endsWith('/api/marketing/brevo/test') && c.method==='POST'));

  await page.getByRole('button', {name:'Refresh Stripe facts'}).click();
  assert.ok(calls.some(c=>c.pathname.endsWith('/api/billing/report/refresh') && c.method==='POST'));
  assert.equal(await page.locator('.mobile-nav').isVisible(), true, 'phone-width navigation uses the selector');
  await page.locator('#hubPageSelect').selectOption('support');
  assert.equal(await page.locator('[data-hub-page-panel="support"]').isVisible(), true);
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth <= window.innerWidth), true, 'mobile layout does not overflow horizontally');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme), 'light dark');
  console.log('Admin launch UI: mocked billing/report/notification workflows, protected writes, release hold and mobile view passed');
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
