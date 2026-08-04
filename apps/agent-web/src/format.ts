/**
 * The readable form of a value the analyst typed or the model read.
 *
 * Shared by the review table, the conversation and the lesson cards, because
 * the same figure appearing three ways in three places is how a UI starts
 * looking untrustworthy.
 *
 * Text that is not a number is returned as it was typed. A field can hold
 * whatever the customer's schema allows, and dressing "see note 7" up as
 * currency would be a lie about what is actually there.
 */
export function readable(value: string): string {
  if (value.trim() === '') return 'blank';

  const asNumber = Number(value);
  return Number.isFinite(asNumber)
    ? asNumber.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
      })
    : value;
}
