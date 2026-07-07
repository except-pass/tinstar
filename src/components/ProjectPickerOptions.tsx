import { type Project, groupForPicker } from '../lib/projects'

/**
 * The <option>/<optgroup> body shared by every native-<select> project picker
 * (New Session, Entity Settings, onboarding). Renders hidden-filtered projects
 * sorted by order, with starred ones in a "★ Favorites" group.
 *
 * `selectedValue` is force-included even when the project is hidden or absent
 * from the list, so a controlled <select> never holds a value with no matching
 * option (which would silently blank the control and strand the selection).
 *
 * Leading options ("None", placeholders, "+ Add project") stay in each parent
 * <select> since they differ per picker.
 */
export function ProjectPickerOptions({
  projects,
  selectedValue,
}: {
  projects: Project[]
  selectedValue?: string
}) {
  const { favorites, others } = groupForPicker(projects)
  const shown = new Set([...favorites, ...others].map(p => p.name))
  const strandedSelection =
    selectedValue && selectedValue.length > 0 && !shown.has(selectedValue)
      ? selectedValue
      : null

  return (
    <>
      {strandedSelection && (
        <option value={strandedSelection}>{strandedSelection} (hidden)</option>
      )}
      {favorites.length > 0 && (
        <optgroup label="★ Favorites">
          {favorites.map(p => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="Projects">
          {others.map(p => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </optgroup>
      )}
    </>
  )
}
