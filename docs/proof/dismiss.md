# Decision dismiss

An isolated home shows one open decision, Choose the rollout order, on worker alpha. The card has a horizontal slide control.

![Decision card with slide to dismiss](dismiss-ready-private.png)

The same control stays on the card when the rail is narrow.

![Decision card on a narrow rail](dismiss-narrow-private.png)

Sliding a keyed decision to the end runs that home's `fm-send.sh --resolve-key`. The card reads dismissed as soon as the script exits 0. No inbox note is saved. A captain-held backlog task is answered with `fm-captain-hold.sh` instead, with `--release` when the hold is on a live worker's own task. A blocked card has no slider. If the script fails, the card shows the script's error and the slider stays for a retry.

![Decision card dismissed](dismiss-closed-private.png)

An unclassified decision still sends one inbox answer. The card reads dismissing while that answer is open, and the note is saved under Messages.

![Unclassified decision dismissing](dismiss-pending-private.png)

When that decision leaves the snapshot, the card leaves the rail. The worker remains. The dismiss answer is then marked done and leaves Messages.

![Rail after the decision leaves](dismiss-gone-private.png)
