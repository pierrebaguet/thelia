// Walks a shop holding a volume dataset as a person would, after the measure: a category, a
// product put into the cart, the cart, then the back-office dashboard, lists and sheets. Each
// step keeps a full-page screenshot, its status, its duration and the console errors, so that the
// screens can be looked at size by size. The paths come from the campaign JSON of the measure.
//
// node walk.mjs <origin> <campaign.json> <output directory>
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [origin, campaignFile, output] = process.argv.slice(2);
const paths = Object.fromEntries(JSON.parse(readFileSync(campaignFile, 'utf8')).pages.map((page) => [page.name, page.path]));
mkdirSync(output, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

const steps = [];
async function step(name, action, check) {
    const errorsBefore = consoleErrors.length;
    const start = Date.now();
    const result = { name, ok: false, status: null, seconds: null, url: null, note: '', consoleErrors: [] };
    try {
        const response = await action();
        result.status = response ? response.status() : null;
        await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
        result.seconds = (Date.now() - start) / 1000;
        result.url = page.url();
        result.note = check ? await check() : '';
        result.ok = (result.status === null || result.status < 400) && !result.note.startsWith('FAIL');
    } catch (error) {
        result.seconds = (Date.now() - start) / 1000;
        result.note = `FAIL ${error.message.split('\n')[0]}`;
    }
    result.consoleErrors = consoleErrors.slice(errorsBefore);
    await page.screenshot({ path: `${output}/${String(steps.length + 1).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
    steps.push(result);
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${name} ${result.status ?? '-'} ${result.seconds}s ${result.note}`);
}

const visit = (path) => () => page.goto(origin + path, { timeout: 600000 });
const countOf = (selector, label) => async () => {
    const count = await page.locator(selector).count();
    return count > 0 ? `${count} ${label}` : `FAIL no ${label}`;
};

// Storefront
await step('category', visit(paths.category), countOf('a[href*=".html"] img', 'product images linked'));
let productTitle = '';
await step('product', visit(paths.product), async () => (productTitle = (await page.locator('h1').first().innerText()).trim()));
await step('add-to-cart', async () => {
    await page.getByRole('button', { name: /add to cart/i }).first().click();
    await page.waitForTimeout(2000);
    return null;
}, async () => 'clicked');
await step('cart', visit('/checkout/cart'), async () => {
    const text = await page.locator('main').innerText();
    return productTitle !== '' && text.includes(productTitle) ? `holds ${productTitle}` : `FAIL ${productTitle || 'the product'} is not in the cart`;
});

// Back office
await step('admin-login', async () => {
    await page.goto(`${origin}/admin/login`);
    await page.fill('input[name="thelia_admin_login[username]"]', 'thelia');
    await page.fill('input[name="thelia_admin_login[password]"]', 'thelia');
    const [response] = await Promise.all([
        page.waitForNavigation({ timeout: 600000 }),
        page.locator('form[action*="checklogin"] [type="submit"]').first().click(),
    ]);
    return response;
}, async () => (page.url().includes('/admin/login') ? 'FAIL still on the sign-in form' : 'signed in'));
await step('admin-dashboard', visit('/admin'));
await step('admin-products', visit('/admin/products'), countOf('table tbody tr', 'rows'));
await step('admin-product', visit(paths['admin-product']), async () => (await page.locator('h1').first().innerText()).trim());
await step('admin-orders', visit('/admin/orders'), countOf('table tbody tr', 'rows'));
await step('admin-order', visit(paths['admin-order']));
await step('admin-customers', visit('/admin/customers'), countOf('table tbody tr', 'rows'));
await step('admin-customer', visit(paths['admin-customer']));

await browser.close();
writeFileSync(`${output}/walk.json`, JSON.stringify(steps, null, 2));
process.exitCode = steps.every((result) => result.ok) ? 0 : 1;
