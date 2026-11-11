export type Mail = { kind: 'collision' | 'split'; text: string };
export function hookResponse(event: string, mail: Mail[], reason = '', enforce = 'hold', stopActive = false) {
  if (event === 'Stop') return stopActive || !mail.length ? { response: {}, delivered: [] } : { response: { decision: 'block', reason: mail.map(m => m.text).join('\n') }, delivered: mail };
  if (!['PreToolUse', 'PostToolUse', 'UserPromptSubmit'].includes(event)) return { response: {}, delivered: [] };
  const text = [...mail.map(m => m.text), ...(enforce === 'off' ? [] : [reason])].filter(Boolean).join('\n');
  if (!text) return { response: {}, delivered: [] };
  return { response: { hookSpecificOutput: { hookEventName: event, ...(event === 'PreToolUse' && reason && enforce === 'hold' ? { permissionDecision: 'deny', permissionDecisionReason: text } : { additionalContext: text }) } }, delivered: mail };
}
