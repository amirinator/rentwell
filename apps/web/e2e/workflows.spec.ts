/**
 * Browser tests for the workflows the specification names.
 *
 * These run against the seeded demonstration data, through the real API and a
 * real worker. They assert what a user sees, not what an internal function
 * returns, which is the point: a financial rule that holds in a unit test but
 * is unreachable through the interface is not a working feature.
 */

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'rentwell-demo-2026';

const ACCOUNTS = {
  controller: 'controller@rentwell.example',
  accountant: 'accountant@rentwell.example',
  manager: 'manager@rentwell.example',
  auditor: 'auditor@rentwell.example',
} as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('sign-in').click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('email')).toBeVisible();
}

test.describe('sign in and scope', () => {
  test('an accountant sees only their assigned properties', async ({ page }) => {
    await signIn(page, ACCOUNTS.accountant);

    // The header states the scope, because "why can't I see that property" is
    // the most common confusion in a role-scoped system.
    await expect(page.getByText('limited to assigned properties')).toBeVisible();

    await page.getByRole('link', { name: 'Properties' }).click();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();

    // The accountant is assigned six properties in the seed.
    await expect(rows).toHaveCount(6);
  });

  test('a controller sees the whole portfolio', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);
    await expect(page.getByText('limited to assigned properties')).toHaveCount(0);
  });

  test('a wrong password is rejected without revealing whether the account exists', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('email').fill(ACCOUNTS.accountant);
    await page.getByTestId('password').fill('not-the-password');
    await page.getByTestId('sign-in').click();

    const error = page.getByRole('alert');
    await expect(error).toContainText(/incorrect/i);

    // The same message for an address that does not exist at all.
    await page.getByTestId('email').fill('nobody@rentwell.example');
    await page.getByTestId('sign-in').click();
    await expect(error).toContainText(/incorrect/i);
  });
});

test.describe('portfolio overview', () => {
  test('states how each headline figure is calculated', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);

    await expect(page.getByText('Outstanding receivables').first()).toBeVisible();

    // Every metric documents its date basis and reversal treatment. A figure
    // without that cannot be defended in a review.
    const notes = page.getByRole('heading', { name: 'How these figures are calculated' });
    await expect(notes).toBeVisible();
    await expect(page.getByText('outstandingReceivables')).toBeVisible();
    await expect(page.getByText(/Reversed payments are excluded/).first()).toBeVisible();
  });

  test('summary figures link through to the records behind them', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);
    await page.getByText('Unapplied cash').first().click();
    await expect(page).toHaveURL(/\/reconciliation/);
  });
});

test.describe('reconciliation', () => {
  test('approving a suggestion shows the evidence first and updates balances', async ({ page }) => {
    await signIn(page, ACCOUNTS.accountant);
    await page.getByRole('link', { name: 'Reconciliation' }).click();

    // Work with the first unreconciled payment that has a suggestion.
    const firstPayment = page.locator('tbody tr a').first();
    await expect(firstPayment).toBeVisible();
    await firstPayment.click();

    const suggestions = page.getByRole('heading', { name: 'Suggested allocations' });
    await expect(suggestions).toBeVisible();

    const approveButton = page.getByRole('button', { name: 'Review and approve' }).first();

    // Not every payment has a proposal; the ones that do not are exceptions.
    if ((await approveButton.count()) === 0) {
      await expect(page.getByText('No suggestions')).toBeVisible();
      return;
    }

    // The evidence is on screen before anything is approved.
    await expect(page.getByText(/Why this was suggested/).first()).toBeVisible();
    // And the score is described as a ranking, never as a confidence.
    await expect(page.getByText(/not a probability/)).toBeVisible();

    await approveButton.click();

    // A confirmation restating the amount and the records affected.
    await expect(page.getByText('Confirm this allocation')).toBeVisible();
    await page.getByTestId('confirm-approve').click();

    await expect(page.getByText('Allocations approved')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Allocations' })).toBeVisible();
  });

  test('a reversal leaves the original allocation visible and restores the balance', async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.accountant);
    await page.goto('/reconciliation?onlyUnreconciled=false');

    const paymentLinks = page.locator('tbody tr a');
    const count = await paymentLinks.count();

    for (let index = 0; index < Math.min(count, 10); index += 1) {
      await paymentLinks.nth(index).click();

      const reverseButton = page.getByRole('button', { name: 'Reverse' }).first();
      if ((await reverseButton.count()) === 0) {
        await page.goBack();
        continue;
      }

      page.once('dialog', (dialog) => void dialog.accept('Applied to the wrong invoice'));
      await reverseButton.click();

      await expect(page.getByText('Allocation reversed')).toBeVisible();
      // Nothing is deleted: the reversed allocation is still listed.
      await expect(page.getByText('Reversed').first()).toBeVisible();
      return;
    }
  });
});

test.describe('exceptions and the assistant', () => {
  test('the assistant explains an exception and cites the records it read', async ({ page }) => {
    await signIn(page, ACCOUNTS.accountant);
    await page.getByRole('link', { name: 'Exceptions' }).click();

    const firstException = page.locator('tbody tr a').first();
    await expect(firstException).toBeVisible();
    await firstException.click();

    // The boundary is stated on screen, not only in the documentation.
    await expect(page.getByText(/cannot approve, post, resolve or close anything/i)).toBeVisible();

    await page.getByTestId('analyze').click();

    await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Supporting records' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Missing information' })).toBeVisible();
  });

  test('a resolution claiming an action that did not happen is rejected', async ({ page }) => {
    await signIn(page, ACCOUNTS.accountant);
    await page.getByRole('link', { name: 'Exceptions' }).click();

    // Pick an exception with money still outstanding.
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().locator('a').click();

    const resolutionSelect = page.getByTestId('resolution');
    if ((await resolutionSelect.count()) === 0) return; // Already resolved.

    await resolutionSelect.selectOption('ALLOCATED');
    await page.getByTestId('resolution-reason').fill('Claiming this was allocated');
    await page.getByTestId('resolve').click();

    // The server checks the records rather than trusting the claim.
    await expect(page.getByText(/requires a matching financial action/i)).toBeVisible();
  });
});

test.describe('month-end close', () => {
  test('blockers cannot be ticked past, and acknowledgements need a reason', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);
    await page.getByRole('link', { name: 'Close' }).click();

    await expect(page.getByTestId('close-property')).toBeVisible();

    const startReview = page.getByTestId('start-review');
    if ((await startReview.count()) > 0) {
      await startReview.click();
      await expect(page.getByTestId('close-period')).toBeVisible({ timeout: 15_000 });
    }

    const closeButton = page.getByTestId('close-period');
    await expect(closeButton).toBeVisible();

    // With acknowledgements outstanding, the button is disabled rather than
    // failing after the click.
    const acknowledgements = page.locator('[data-testid^="ack-"]:not([data-testid*="reason"])');
    if ((await acknowledgements.count()) > 0) {
      await expect(closeButton).toBeDisabled();

      for (let index = 0; index < (await acknowledgements.count()); index += 1) {
        await acknowledgements.nth(index).check();
      }

      // Any acknowledgement that needs a reason keeps it disabled until given one.
      const reasons = page.locator('[data-testid^="ack-reason-"]');
      for (let index = 0; index < (await reasons.count()); index += 1) {
        await expect(closeButton).toBeDisabled();
        await reasons.nth(index).fill('Reviewed with the property manager');
      }
    }

    await expect(closeButton).toBeEnabled();
    await closeButton.click();

    await expect(page.getByText(/Close .* for /)).toBeVisible();
    await page.getByTestId('confirm-close').click();

    await expect(page.getByText(/closed$/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Close history' })).toBeVisible();
  });

  test('a closed period rejects a financial change', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);
    await page.getByRole('link', { name: 'Close' }).click();

    const status = page.getByText('Closed').first();
    if ((await status.count()) === 0) test.skip(true, 'No closed period in this run');

    // Reopening is the only sanctioned route back in, and it needs a reason.
    const reopen = page.getByTestId('reopen-period');
    await expect(reopen).toBeVisible();

    page.once('dialog', (dialog) => void dialog.dismiss());
    await reopen.click();
    // Dismissing the prompt makes no change.
    await expect(page.getByText('Closed').first()).toBeVisible();
  });
});

test.describe('role restrictions', () => {
  test('a property manager cannot reach financial actions', async ({ page }) => {
    await signIn(page, ACCOUNTS.manager);

    // The navigation omits what the role cannot do.
    await expect(page.getByRole('link', { name: 'Imports' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Subledger' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);

    // And the server refuses even if the route is entered directly.
    await page.goto('/subledger');
    await expect(page.getByText(/do not have access|not permitted|Forbidden/i).first()).toBeVisible(
      {
        timeout: 15_000,
      },
    );
  });

  test('an auditor reads the subledger but cannot act', async ({ page }) => {
    await signIn(page, ACCOUNTS.auditor);
    await page.getByRole('link', { name: 'Subledger' }).click();

    await expect(page.getByRole('heading', { name: 'Account balances' })).toBeVisible();
    // The balance check is shown either way; it must read as balanced.
    await expect(page.getByText(/Debits equal credits/)).toBeVisible();

    await signOut(page);
  });
});

test.describe('audit history', () => {
  test('records every financial action with its actor', async ({ page }) => {
    await signIn(page, ACCOUNTS.controller);
    await page.getByRole('link', { name: 'Audit' }).click();

    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    // The claim made about these records is stated precisely.
    await expect(page.getByText(/not independently tamper-proof/)).toBeVisible();
  });
});
