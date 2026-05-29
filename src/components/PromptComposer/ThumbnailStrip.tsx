import type { Tile } from './useScreenshotUpload'

interface Props {
  tiles: Tile[]
  onRemove: (clientId: string) => void
}

export function ThumbnailStrip({ tiles, onRemove }: Props) {
  if (tiles.length === 0) return null

  return (
    <div
      data-testid="thumbnail-strip"
      className="flex flex-row gap-1 overflow-x-auto max-w-[220px]"
    >
      {tiles.map(t => (
        <div
          key={t.clientId}
          data-testid={`thumb-tile-${t.clientId}`}
          className="relative w-12 h-12 flex-shrink-0 rounded overflow-hidden border border-slate-600 group"
        >
          <img
            src={t.previewUrl}
            alt=""
            className="w-full h-full object-cover"
          />
          {t.status === 'pending' && (
            <div
              data-testid={`thumb-spinner-${t.clientId}`}
              className="absolute inset-0 flex items-center justify-center bg-black/40"
            >
              <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {t.status === 'error' && (
            <div
              data-testid={`thumb-error-${t.clientId}`}
              title={t.errorMessage}
              className="absolute inset-0 flex items-center justify-center bg-red-900/70 text-red-200 text-xs"
            >
              ⚠
            </div>
          )}
          <button
            type="button"
            data-testid={`thumb-remove-${t.clientId}`}
            onClick={(e) => { e.stopPropagation(); onRemove(t.clientId) }}
            className="absolute top-0 right-0 px-1 text-xs text-white bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Remove screenshot"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
