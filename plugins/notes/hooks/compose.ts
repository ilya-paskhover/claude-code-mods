// What /note saves: the selection when there is one, the typed text riding
// along as its comment; otherwise the typed text itself.
export type Composed = { text: string; comment?: string; requestId?: string }

const PREVIEW_LINES = 6
const PREVIEW_CHARS = 400

// Pasting into the prompt can wrap the text in a <pasted_content> tag pair.
export const clean = (text: string) =>
  text
    .replace(/<pasted_content\b[^>]*>\r?\n?/g, '')
    .replace(/\r?\n?<\/pasted_content\b[^>]*>/g, '')
    .trim()

export const compose = (
  selection: { text: string; requestId?: string } | undefined,
  typed: string,
): Composed | undefined => {
  const selected = clean(selection?.text ?? '')
  const args = clean(typed)
  if (selected !== '') {
    return { text: selected, comment: args !== '' ? args : undefined, requestId: selection?.requestId }
  }
  return args !== '' ? { text: args } : undefined
}

// The first lines of a long note, closing a code fence the cut left open.
export const preview = (text: string): { text: string; isCut: boolean } => {
  const lines = text.split('\n')
  let shown = lines.slice(0, PREVIEW_LINES).join('\n')
  if (shown.length > PREVIEW_CHARS) shown = `${shown.slice(0, PREVIEW_CHARS)}…`
  if (shown === text) return { text, isCut: false }
  const fences = (shown.match(/^\s*```/gm) ?? []).length
  return { text: fences % 2 === 1 ? `${shown}\n\`\`\`` : shown, isCut: true }
}
