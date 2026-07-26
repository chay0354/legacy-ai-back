/** Stage 3 — Legacy Avatar: values, personality, pain, and conscious legacy (13 anchor sections) */
export const LEGACY_QUESTIONS = [
  {
    module: 'What Should Be Remembered',
    category: 'legacy_remembered',
    q: 'When people in your family think about you many years from now, what do you hope they remember?',
    digFor: '2–3 concrete remembrances (traits, deeds, sayings) — not only “that I loved them”',
  },
  {
    module: 'What Should Never Be Lost',
    category: 'legacy_preserve',
    q: 'What do you think should never be lost in this family — traditions, values, or beliefs?',
    digFor: 'a named tradition, value, or belief and why it matters to keep',
  },
  {
    module: 'Future Generations',
    category: 'legacy_future',
    q: 'What do you want your grandchildren and great-grandchildren to understand about life?',
    digFor: 'one clear life understanding in their voice, as if said to a grandchild',
  },
  {
    module: 'Family Identity',
    category: 'legacy_family',
    q: 'What does it mean to be part of this family? What makes this family special?',
    digFor: 'specific family traits, habits, or stories that define “us”',
  },
  {
    module: 'The Most Important Story',
    category: 'legacy_story',
    q: 'If future generations could hear only one story from your life, which story would you choose — and why?',
    digFor: 'which story and a short telling of what happened, plus why that one',
  },
  {
    module: 'The Most Important Lesson',
    category: 'legacy_lesson',
    q: 'If you could teach only one lesson to future generations, what would it be?',
    digFor: 'one lesson stated plainly, preferably with the experience behind it',
  },
  {
    module: 'What Matters Most',
    category: 'legacy_meaning',
    q: 'When you look back on your life, what mattered most? What mattered less than you expected?',
    digFor: 'one thing that mattered most and one that mattered less, each with a brief why',
  },
  {
    module: 'What People Miss',
    category: 'legacy_misunderstood',
    q: 'What do you think people today misunderstand about life?',
    digFor: 'one misunderstanding named, and what they wish people understood instead',
  },
  {
    module: 'Life Summary',
    category: 'legacy_summary',
    q: 'If you had to summarize your life in a few paragraphs, what would you say?',
    digFor: 'a short arc with real chapters (origins, work, love, later life) — not generic poetry',
  },
  {
    module: 'The Legacy Letter',
    category: 'legacy_letter',
    q: 'Imagine a family member reading a letter from you 100 years from now. What would you want them to know?',
    digFor: 'letter-like lines they would actually write: love, facts, wishes — specific',
  },
  {
    module: 'The Final Conversation',
    category: 'legacy_final',
    q: 'If this were the last conversation you could ever have with your family, what would you want to say?',
    digFor: 'words they would speak aloud to family — gratitude, blessing, or unfinished truth',
  },
  {
    module: 'Gratitude',
    category: 'legacy_gratitude',
    q: 'What are you most grateful for when you look back on your life?',
    digFor: 'specific people, moments, or gifts of luck — named, not a vague “everything”',
  },
  {
    module: 'Hope',
    category: 'legacy_hope',
    q: 'What do you hope for the future of your family?',
    digFor: 'a concrete hope for the family’s future (relationships, values, wellbeing)',
  },
];

export const LEGACY_COVERAGE_CATEGORIES = LEGACY_QUESTIONS.map((q) => q.category);
