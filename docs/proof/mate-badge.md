# Second mate badge

An isolated home shows three workers in one project. Harbor's snapshot kind is `secondmate`. Keel is a ship worker and lookout is a scout. Only harbor has a Second mate badge on its overview card. Grouping is unchanged.

![Overview with one Second mate badge](mate-badge-overview-private.png)

The same badge is in the detail rail, with the state chip and the Direct or Managed control.

![Detail rail with the Second mate badge](mate-badge-detail-private.png)

When the detail rail collapses to a slim header, the badge stays on that line while the name still fits.

![Slim header with the Second mate badge](mate-badge-header-private.png)

`e2e/cockpit-mate-badge.spec.ts` runs this home on a private tmux socket. Below 760px the header line cannot hold the badge with the name, state, and Direct control, so the badge is shown in the details body instead.
