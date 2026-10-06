/**
 * Codex `item/tool/requestUserInput` <-> DSH `userQuestions.ask`.
 * Secret questions are never relayed: DSH renders answers in the transcript.
 */
export function toDshQuestions(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : []
  return questions
    .filter(question => question && typeof question.id === 'string' && !question.isSecret)
    .map(question => ({
      id: question.id,
      question: String(question.question ?? question.header ?? question.id).slice(0, 2000),
      ...(question.header ? { header: String(question.header).slice(0, 24) } : {}),
      ...(Array.isArray(question.options) && question.options.length
        ? {
            options: question.options.slice(0, 8).map(option => ({
              label: String(option.label ?? '').slice(0, 200),
              ...(option.description ? { description: String(option.description).slice(0, 500) } : {}),
            })),
          }
        : {}),
    }))
}

export function toCodexAnswers(answer) {
  const answers = {}
  for (const item of answer?.answers ?? []) {
    if (!item || typeof item.id !== 'string') continue
    const values = [...(item.selected ?? [])]
    if (typeof item.custom === 'string' && item.custom.trim()) values.push(item.custom)
    answers[item.id] = { answers: values }
  }
  return { answers }
}
