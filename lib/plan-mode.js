/**
 * Fallback plan review: when Codex produced a plan item but never called the
 * exit_plan_mode tool, synthesise the same native review card so the user
 * still gets an approve/decline decision point.
 */
export async function planReviewFallback({ ctx, agent, recorder, plan, signal }) {
  const normalized = plan.trim().startsWith('#') ? plan.trim() : `# 执行计划\n\n${plan.trim()}`
  recorder?.start({ id: 'plan-fallback', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: normalized }) })
  const questions = ctx.get('userQuestions')
  if (!questions) {
    recorder?.finish({ id: 'plan-fallback', output: '当前界面不支持计划审批；请使用 /plan off 手动切换。', isError: true })
    return false
  }
  try {
    const answers = await questions.ask({
      questions: [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: normalized,
        options: [
          { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
          { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
        ],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
      agent,
      signal,
    })
    const answer = answers?.answers?.find?.(entry => entry.id === 'plan-review')?.selected?.[0]
    if (answer === 'Approve') {
      recorder?.finish({ id: 'plan-fallback', output: '计划已批准；请发送消息开始执行。' })
      try {
        ctx.get('planMode')?.set(agent, false)
      } catch {
        try { agent.session.append('plan/mode', { active: false }) } catch {}
      }
      return true
    }
    const feedback = answer && answer !== 'Keep planning' ? `：${answer}` : ''
    recorder?.finish({ id: 'plan-fallback', output: `用户希望继续讨论或修改计划${feedback}；计划模式保持开启。`, isError: true })
    return false
  } catch (error) {
    const name = String(error?.name ?? error)
    if (/abort/i.test(name)) {
      recorder?.finish({ id: 'plan-fallback', output: '计划审批被中断。', isError: true })
      return false
    }
    recorder?.finish({ id: 'plan-fallback', output: '计划审批失败；请使用 /plan off 手动切换。', isError: true })
    return false
  }
}
