export type ModelSelection = {
  providerID: string
  modelID: string
  variant?: string | null
}

export function formatModelSelection(selection: ModelSelection): string {
  const base = `${selection.providerID}/${selection.modelID}`
  if (selection.variant) return `${base} (${selection.variant})`
  return base
}

export function parseModelRef(value: string): { providerID: string; modelID: string } | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  }
}
