/**
 * Shown when a request has been refused because the hosting is asleep.
 *
 * Undismissable on purpose. There is nothing behind it that works — every call
 * the page can make is failing for the same reason — so a close button would
 * only return the analyst to a screen that cannot do anything, with the
 * explanation removed.
 */
export default function WakingBackend() {
  return (
    <div className="waking-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="waking-title">
      <div className="waking-modal">
        <span className="spinner" aria-hidden="true" />
        <h2 id="waking-title">Starting the backend</h2>
        <p>
          This demo runs on a free hosting tier, which shuts the backend services
          down after fifteen minutes without traffic. They are being started
          again now.
        </p>
        <p className="subtle">
          This usually takes under a minute, and only happens on the first visit
          after a quiet period. Everything is quick once they are up.
        </p>
      </div>
    </div>
  );
}
