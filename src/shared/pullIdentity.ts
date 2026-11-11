export interface PullIdentity { id: string; repository: string; number: number; url: string }
/** GitHub identity is repository + number; URLs with query/fragment retain that identity. */
export function releasePull(value: string): PullIdentity | null {
  try {
    const url = new URL(value)
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !match) return null
    const repository = `${match[1]}/${match[2]}`.toLowerCase(), number = Number(match[3])
    if (!Number.isSafeInteger(number)) return null
    return { id: `${repository}#${number}`, repository, number, url: `https://github.com/${repository}/pull/${number}` }
  } catch { return null }
}
