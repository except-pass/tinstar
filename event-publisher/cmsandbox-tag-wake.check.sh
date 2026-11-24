#!/usr/bin/env bash
set -u
umask 077

fail() {
  printf 'cmsandbox tag wake: %s\n' "$1" >&2
  exit 1
}

cursor=${TAG_WAKE_CURSOR:-$(dirname -- "$0")/cmsandbox-tag-wake.cursor}
exec 9>>"$cursor.lock" || fail 'cannot open cursor lock'
flock -n -E 75 9
case $? in
  0) ;;
  75) exit 0 ;;
  *) fail 'cannot lock cursor' ;;
esac

after=0
if [[ -e $cursor ]]; then
  after=$(cat -- "$cursor") || fail 'cannot read cursor'
fi
[[ $after =~ ^(0|[1-9][0-9]*)$ ]] || fail 'cursor must contain a journal sequence'

printf -v remote '%q replay --db %q --source github --type tag --after %q --json' \
  "${TAG_WAKE_REMOTE_EVENTS:-/home/farm/srv/event-publisher/app/event-publisher/events}" \
  "${TAG_WAKE_REMOTE_DB:-/home/farm/srv/event-publisher/data/journal.sqlite}" "$after"
rows=$(timeout 25 ssh -o BatchMode=yes -o ConnectTimeout=8 -- \
  "${HULK_SSH:-farm@hulk.taile890bc.ts.net}" "$remote" 2>/dev/null) || fail 'cannot read Hulk journal over SSH'

batch=$(printf '%s' "$rows" | jq -er -s --argjson after "$after" '
  if all(.[]; (.sequence | type) == "number" and .sequence > $after and (.sequence | floor) == .sequence)
  then
    ([$after, .[].sequence] | max),
    (.[] | select(.source.source_id == "github:cmsandbox-tags" and .source.mode == "live" and .event_type == "tag.pushed")
      | .evidence.source_reference as $ref
      | if $ref.repository == "fortresspower/cmsandbox"
          and ($ref.tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
          and ($ref.sha | test("^[a-f0-9]{40,64}$"))
          and (.observed_at | test("^[0-9T:.-]+Z$"))
          and (.evidence.action | IN("created", "moved", "restored"))
        then "tag pushed \($ref.repository) \($ref.tag) \($ref.sha) \(.observed_at) \(.evidence.action) #\(.sequence)"
        else error("invalid push event")
        end)
  else error("invalid replay sequence")
  end
') || fail 'invalid Hulk replay'
next=${batch%%$'\n'*}
if [[ $next != "$after" || ! -e $cursor ]]; then
  temp=$(mktemp -- "$cursor.tmp.XXXXXXXX") || fail 'cannot stage cursor'
  trap 'rm -f -- "$temp"' EXIT
  printf '%s\n' "$next" > "$temp" || fail 'cannot write cursor'
  if [[ $batch == *$'\n'* ]]; then
    # Emit before committing the cursor so a failed write can be retried.
    printf '%s\n' "${batch#*$'\n'}" || fail 'cannot emit wake lines'
  fi
  mv -f -- "$temp" "$cursor" || fail 'cannot commit cursor'
fi
