import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import axios from 'axios'
import { CookieJar } from 'tough-cookie'
import { wrapper } from 'axios-cookiejar-support'
import yargs from 'yargs'
import 'dotenv/config'
puppeteer.use(StealthPlugin())

// ─── Configuration Parsing ─────────────────────────────────────────────────────

const cliArgs = yargs(process.argv.slice(2))
    .option('email', { type: 'string', describe: 'Raleys account email address' })
    .option('password', { type: 'string', describe: 'Raleys account password' })
    .option('headless', { type: 'boolean', default: true, describe: 'Run browser in headless mode' })
    .option('minStartDelay', { type: 'number', describe: 'Minimum random delay before starting the script in milliseconds (default 0)', alias: 'minstartdelay' })
    .option('maxStartDelay', { type: 'number', describe: 'Maximum random delay before starting the script in milliseconds (default 0)', alias: 'maxstartdelay' })
    .option('minRequestDelay', { type: 'number', describe: 'Minimum random delay between clip requests in milliseconds (default 1000)', alias: 'minrequestdelay' })
    .option('maxRequestDelay', { type: 'number', describe: 'Maximum random delay between clip requests in milliseconds (default 5000)', alias: 'maxrequestdelay' })
    .help()
    .parseSync()


function getConfig() {
    const getEnvNumber = (key, fallback) => process.env[key] !== undefined ? parseInt(process.env[key], 10) : fallback;

    return {
        email: cliArgs.email || process.env.RALEYS_EMAIL,
        password: cliArgs.password || process.env.RALEYS_PASSWORD,
        headless: cliArgs.headless,
        minStartDelay: cliArgs.minStartDelay ?? getEnvNumber("MIN_START_DELAY", 0),
        maxStartDelay: cliArgs.maxStartDelay ?? getEnvNumber("MAX_START_DELAY", 0),
        minRequestDelay: cliArgs.minRequestDelay ?? getEnvNumber("MIN_REQUEST_DELAY", 1000),
        maxRequestDelay: cliArgs.maxRequestDelay ?? getEnvNumber("MAX_REQUEST_DELAY", 5000),
    }
}
const config = getConfig();

if (!config.email || !config.password) {
    console.error('[ERROR] Missing credentials: provide --email and --password or set in .env');
    process.exit(1);
}
    


const sleep = ms => new Promise(res => setTimeout(res, ms))
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min)

const chosenDelay = Math.round(Math.random() * (config.maxStartDelay - config.minStartDelay + 1) + config.minStartDelay)
console.log(`[Info] Waiting ${chosenDelay}ms before starting...`)
await sleep(chosenDelay)

async function getLoginCookiesFromBrowser() {
    console.log('[Info] Starting up...')
    const browser = await puppeteer.launch({ headless: config.headless })
    const page = await browser.newPage()
    await page.goto('https://www.raleys.com/', { waitUntil: 'networkidle2' })
    await page.click('#header > nav > div > div.flex.h-14.items-center.justify-between.gap-2.px-4.py-2.tablet\\:gap-5.tablet\\:px-8 > div.tablet\\:block.desktop\\:order-3.desktop\\:block > div > div.hidden.w-fit.tablet\\:block > div > p > a:nth-child(1)')
    await page.waitForSelector('#email', { visible: true })

    await page.type('#email', config.email)
    await page.type('#password', config.password)

    console.log('[Info] Logging in...')
    await Promise.all([
        page.click('#auth-modal > div > div.space-y-4.px-6.pb-4.sm\\:pb-6.lg\\:px-8.xl\\:pb-8.overflow-y-auto.tablet\\:max-h-160 > div > form > div.flex.justify-center > button'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ])

    const cookies = await page.cookies()

    console.log('[Info] Logged in successfully')
    await browser.close()

    return cookies
}

// Converts Puppeteer cookies to tough-cookie Jar
function setCookiesToJar(jar, cookies, url) {
    cookies.forEach(({ name, value, domain, path, expires, httpOnly, secure }) => {
        jar.setCookieSync(
            `${name}=${value}; Domain=${domain}; Path=${path}; ${httpOnly ? 'HttpOnly;' : ''} ${secure ? 'Secure;' : ''}`,
            url
        )
    })
}


const cookies = await getLoginCookiesFromBrowser()
const jar = new CookieJar()
setCookiesToJar(jar, cookies, 'https://www.raleys.com')

const raleysClient = wrapper(axios.create({
    baseURL: 'https://www.raleys.com',
    jar,
    withCredentials: true,
}))


async function clipOffer(offer) {
    try {
        const offerId = offer.ExtPromotionId
        const offerType = offer.ExtBadgeTypeCode
        const isCoupon = offer.ExtBadgeTypeCode == 'mfg'
        await raleysClient.post('/api/offers/accept' + (isCoupon ? '-coupons' : ''), {
            offerId,
            offerType: offerType
        })
        return true
    } catch (error) {
        console.warn(`\n[Warn] Error accepting ${offer.ExtBadgeTypeCode == "mfg" ? "Coupon" : offer.ExtBadgeTypeCode} offer: ${offer.Headline}:`, error.response ? error.response.data : error.message)
        return false
    }
}

const offerTypes = ['SomethingExtra', 'WeeklyExclusive', 'DigitalCoupons']

console.log(`[Info] Checking for ${offerTypes.join(', ')} offers...`)

let totalOffersClipped = 0

for (const offerType of offerTypes) {
    const offersResponse = await raleysClient.get(`/api/offers/targeted?offset=0&rows=999&type=available&filter=${offerType}`)
    const offers = offersResponse.data
    console.log(`---\n[Info] ${offers.total} ${offerType} offer${offers.total == 1 ? '' : 's'} found`)
    if (offers.total === 0) {
        continue
    }

    for (const [i, offer] of offers.data.entries()) {
        process.stdout.write(`[Info] Clipping ${offer.ExtBadgeTypeCode == "mfg" ? "Coupon" : offer.ExtBadgeTypeCode}: ${offer.Headline} ${offer.SubHeadline?.replace(/[\r\n]+/g, ' ')}...`)
        if (!offer || !offer.ExtPromotionId || !offer.ExtBadgeTypeCode) console.warn(`[Warn] Invalid offer data detected`)
        const success = await clipOffer(offer)
        if (success)
            console.log(`\r[Info] Clipped ${offer.ExtBadgeTypeCode == "mfg" ? "Coupon" : offer.ExtBadgeTypeCode}: ${offer.Headline} ${offer.SubHeadline.replace(/[\r\n]+/g, ' ')}    `)
        if (i < offers.data.length - 1)
            await randomSleep(config.minRequestDelay, config.maxRequestDelay)
    }
    console.log(`[Info] Successfully clipped ${offers.total} ${offerType} offer${offers.total == 1 ? '' : 's'}`)
    totalOffersClipped += offers.total
}

if (totalOffersClipped === 0)
    console.log('---\n[Info] No offers available to be clipped. Program exiting.')
else
    console.log(`---\n[Info] Success! ${totalOffersClipped} offer${totalOffersClipped == 1 ? '' : 's'} clipped in total.`)
