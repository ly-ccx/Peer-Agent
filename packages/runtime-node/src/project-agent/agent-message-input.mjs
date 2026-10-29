const bounded = (value, size) => typeof value === 'string' && value.trim() && value.length <= size;
const keysAllowed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

/** Parse the optional decision/delivery contract; host identity and authorization are separate. */
export function parseAgentMessageExtension(input) {
  const value = {};
  if (input.delivery !== undefined) {
    if (!['mailbox_only', 'ensure_turn'].includes(input.delivery)) return { ok: false };
    value.delivery = input.delivery;
  }
  if (input.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false };
    value.expectedRevision = input.expectedRevision;
  }
  if (input.expectedExecutionEpoch !== undefined) {
    if (!bounded(input.expectedExecutionEpoch, 200)) return { ok: false };
    value.expectedExecutionEpoch = input.expectedExecutionEpoch;
  }
  if (input.decisionRequest !== undefined) {
    const request = input.decisionRequest;
    if (!keysAllowed(request, ['options', 'multiple', 'allowText'])
      || request.multiple !== undefined && typeof request.multiple !== 'boolean'
      || request.allowText !== undefined && typeof request.allowText !== 'boolean') return { ok: false };
    if (request.options !== undefined && (!Array.isArray(request.options) || request.options.length > 16
      || request.options.some(option => !keysAllowed(option, ['optionId', 'label']) || !bounded(option.optionId, 100) || !bounded(option.label, 1000))
      || new Set(request.options.map(option => option.optionId)).size !== request.options.length)) return { ok: false };
    if (request.allowText === false && !request.options?.length) return { ok: false };
    value.decisionRequest = { ...(request.options ? { options: request.options.map(option => ({ optionId: option.optionId, label: option.label })) } : {}),
      multiple: request.multiple === true, allowText: request.allowText !== false };
  }
  if (input.decisionAnswer !== undefined) {
    const answer = input.decisionAnswer;
    if (!keysAllowed(answer, ['requestId', 'expectedRequestRevision', 'optionIds', 'text']) || !bounded(answer.requestId, 200)
      || !Number.isSafeInteger(answer.expectedRequestRevision) || answer.expectedRequestRevision < 1
      || answer.text !== undefined && !bounded(answer.text, 4000)
      || answer.optionIds !== undefined && (!Array.isArray(answer.optionIds) || answer.optionIds.length > 16
        || answer.optionIds.some(id => !bounded(id, 100)) || new Set(answer.optionIds).size !== answer.optionIds.length)) return { ok: false };
    value.decisionAnswer = { requestId: answer.requestId, expectedRequestRevision: answer.expectedRequestRevision,
      ...(answer.optionIds ? { optionIds: [...answer.optionIds] } : {}), ...(answer.text ? { text: answer.text.trim() } : {}) };
  }
  return { ok: true, value };
}
