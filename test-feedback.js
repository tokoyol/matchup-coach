const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        recordVideo: { dir: 'videos/' }
    });

    const page = await context.newPage();
    await page.goto('http://localhost:5173');

    // Switch to English language
    await page.selectOption('select', 'en');

    // Submit form for top lane matchup
    await page.click('button[type="submit"]');

    // Wait for the response and result card to appear
    await page.waitForSelector('.result-grid', { state: 'visible', timeout: 15000 });

    console.log("Result card appeared");

    // Wait for the feedback buttons
    await page.waitForSelector('text="Good"', { state: 'visible' });

    // Click the "Good" feedback button
    await page.click('text="👍 Good"');

    // Wait for the 'Thanks for the feedback' message
    await page.waitForSelector('text="Thanks for the feedback!"', { state: 'visible', timeout: 5000 });

    console.log("Feedback submitted successfully");

    // Clean up
    await context.close();
    await browser.close();
    console.log("Test finished!");
})();
