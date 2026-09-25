import { useEffect, useState } from 'react'
import { getAvatarDataUrl, subscribeAvatarCache } from '../../components/agentAvatarCache'

/** The rail face: DiceBear bottts seeded by worker id, ringed with that worker's color. */
export function WorkerFace({ id, color }: { id: string; color: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const read = () => setUrl(getAvatarDataUrl(id, color))
    read()
    return subscribeAvatarCache(read)
  }, [id, color])
  if (!url) {
    return <span aria-hidden data-face={id} className="inline-block h-7 w-7 rounded-full border-2" style={{ borderColor: color }} />
  }
  return <img data-face={id} src={url} alt="" width={28} height={28} className="h-7 w-7 rounded-full border-2" style={{ borderColor: color }} />
}
