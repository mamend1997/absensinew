export function getDefaultPage({ subscriptionExpired, billingReturn, canScan }) {
  if (subscriptionExpired || billingReturn) return 'billing';
  return canScan ? 'scanner' : 'dashboard';
}
