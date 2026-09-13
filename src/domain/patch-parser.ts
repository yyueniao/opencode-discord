export class PatchParser {
  parseFileCounts(patchText: string): Map<string, { additions: number; deletions: number }> {
    const counts = new Map<string, { additions: number; deletions: number }>()
    const lines = patchText.split('\n')
    let currentFile = ''
    let inHunk = false

    for (const line of lines) {
      const addMatch = line.match(/^\*\*\* Add File:\s*(.+)/)
      const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)/)
      const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)/)

      if (addMatch || updateMatch || deleteMatch) {
        const match = addMatch || updateMatch || deleteMatch
        currentFile = (match?.[1] ?? '').trim()
        counts.set(currentFile, { additions: 0, deletions: 0 })
        inHunk = false
        continue
      }

      if (line.startsWith('@@')) {
        inHunk = true
        continue
      }

      if (line.startsWith('*** ')) {
        inHunk = false
        continue
      }

      if (!currentFile || !inHunk) continue

      const current = counts.get(currentFile)
      if (!current) continue
      if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1
      if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1
    }

    return counts
  }
}
