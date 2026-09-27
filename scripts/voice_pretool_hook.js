#!/usr/bin/env node
// Claude Code "PreToolUse" hook, registered matched to "AskUserQuestion|ExitPlanMode"
// only (see ensure_voice_hook.js): speaks a summary of what's being asked
// right as the prompt is about to be shown, since neither tool's content
// reaches the Stop hook (it lives in tool_input, not assistant text — see
// README's "Reading responses aloud" section).
//
// ExitPlanMode plans can be long, so we deliberately do NOT read the plan
// itself aloud by default — only a short announcement is spoken. The full
// plan text (Markdown-stripped) is sent as `replayText`, which the relay
// keeps and only speaks again on request ("repeat that"). This also means
// approval always happens the normal way (keyboard/mouse) — the announcement
// doesn't ask for or accept a spoken yes/no.
'use strict';

const { stripMarkdown, runVoiceHook } = require('./voice_common');

function summarizeQuestions(toolInput) {
  const questions = Array.isArray(toolInput && toolInput.questions) ? toolInput.questions : [];
  if (!questions.length) return 'Claude has a question for you.';
  const parts = questions.map((q) => {
    const question = (q && q.question) || '';
    const options = Array.isArray(q && q.options) ? q.options.map((o) => o && o.label).filter(Boolean) : [];
    const optionsText = options.length ? ` Options: ${options.join(', ')}.` : '';
    return `${question}${optionsText}`;
  });
  const lead = parts.length > 1 ? 'Claude has questions for you. ' : 'Claude has a question: ';
  return lead + parts.join(' Next question: ');
}

runVoiceHook(async (payload, speak) => {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};

  if (toolName === 'ExitPlanMode') {
    const plan = String(toolInput.plan || '').trim();
    if (!plan) return;
    const announcement = "Claude has a plan ready for your approval. Say 'repeat that' to hear it.";
    await speak(announcement, stripMarkdown(plan));
    return;
  }

  if (toolName === 'AskUserQuestion') {
    await speak(summarizeQuestions(toolInput));
    return;
  }
});
