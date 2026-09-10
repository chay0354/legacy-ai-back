/** Stage 3 — Legacy Avatar: values, personality, pain, and conscious legacy (13 anchor sections) */
export const LEGACY_QUESTIONS = [
  {
    module: 'What Should Be Remembered',
    category: 'legacy_remembered',
    q: 'When people in your family think about you many years from now, what do you hope they remember?',
    digFor: 'what they hope stays — a trait, a deed, a saying, or a feeling; let them choose',
  },
  {
    module: 'What Should Never Be Lost',
    category: 'legacy_preserve',
    q: 'What do you think should never be lost in this family — a tradition, a value, a belief, or just a way of being?',
    digFor: 'whatever they want kept, and why it matters to them',
  },
  {
    module: 'Future Generations',
    category: 'legacy_future',
    q: 'What do you want your grandchildren and great-grandchildren to understand about life — if you could sit with them?',
    digFor: 'what they would say, in their voice; it does not have to sound like advice',
  },
  {
    module: 'Family Identity',
    category: 'legacy_family',
    q: 'What does it mean to be part of this family? What makes this family itself, as you see it?',
    digFor: 'how they would describe “us” — habits, stories, or a feeling of belonging',
  },
  {
    module: 'The Most Important Story',
    category: 'legacy_story',
    q: 'If future generations could hear only one story from your life, which would you choose — and why? Tell it however you remember it.',
    digFor: 'the story they pick and why that one; let them tell it in their own shape',
  },
  {
    module: 'The Most Important Lesson',
    category: 'legacy_lesson',
    q: 'If you could leave only one thing for the people who come after you, what would it be?',
    digFor: 'the one thing they would leave — a lesson, a hope, or a truth; the experience behind it if they offer it',
  },
  {
    module: 'What Matters Most',
    category: 'legacy_meaning',
    q: 'When you look back, what mattered most? And was there anything that mattered less than you expected?',
    digFor: 'what rose and what fell away, in their words — they can take either side first',
  },
  {
    module: 'What People Miss',
    category: 'legacy_misunderstood',
    q: 'Is there something you think people today miss about life — or get wrong?',
    digFor: 'what they wish people understood; stay with their thought, not a debate',
  },
  {
    module: 'Life Summary',
    category: 'legacy_summary',
    q: 'If you were telling the story of your life, not neatly — just how you’d tell it — what would you say?',
    digFor: 'the arc as they tell it; origins, work, love, later years if they go there',
  },
  {
    module: 'The Legacy Letter',
    category: 'legacy_letter',
    q: 'Imagine someone in the family reading a letter from you a hundred years from now. What would you want them to know?',
    digFor: 'what they would write — love, facts, wishes — in lines that sound like them',
  },
  {
    module: 'The Final Conversation',
    category: 'legacy_final',
    q: 'If this were the last conversation you could have with your family, what would you want to say?',
    digFor: 'what they would actually say — gratitude, a blessing, or something unfinished',
  },
  {
    module: 'Gratitude',
    category: 'legacy_gratitude',
    q: 'What are you most grateful for when you look back — people, moments, or luck you didn’t expect?',
    digFor: 'what they name with feeling; a person or moment if one surfaces',
  },
  {
    module: 'Hope',
    category: 'legacy_hope',
    q: 'What do you hope for the future of your family?',
    digFor: 'the hope they hold — for how they treat each other, what they keep, or how they live',
  },
];

export const LEGACY_COVERAGE_CATEGORIES = LEGACY_QUESTIONS.map((q) => q.category);
