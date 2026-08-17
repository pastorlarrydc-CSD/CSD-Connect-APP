// Non-secret Stripe configuration. The price ID identifies a specific
// Product+Price combination in the Stripe dashboard (currently:
// "CoachConnect Access", $99.00/month, 14-day trial applied at checkout
// time via subscription_data.trial_period_days). Price IDs are safe to
// ship in client-visible code -- they carry no purchasing power on their
// own, unlike the secret key used server-side to create sessions.
export const STRIPE_PRICE_ID = "price_1U5S8VLYJtUTDn82oGUHN1eY";
export const TRIAL_PERIOD_DAYS = 14;
