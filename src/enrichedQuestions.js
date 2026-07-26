/** Stage 2 — Enriched Avatar: stories, relationships, wisdom (anchor questions from each engine) */
export const ENRICHED_QUESTIONS = [
  {
    module: 'Story Deep-Dive',
    category: 'story_scene',
    q: 'Tell me a story from your life that still matters to you — take me there. What do you remember seeing?',
    digFor: 'one scene with place, people present, and sensory detail (what they saw/heard) — not a summary',
  },
  {
    module: 'Story Meaning',
    category: 'story_meaning',
    q: 'When you look back on that story now, what does it mean to you? Why do you still remember it?',
    digFor: 'why that specific story stuck, in their words — link meaning to a detail from the scene',
  },
  {
    module: 'Story Legacy',
    category: 'story_legacy',
    q: 'What lesson came from that experience? What should future generations learn from this story?',
    digFor: 'one transferable lesson phrased as advice, grounded in that story',
  },
  {
    module: 'Relationship',
    category: 'relationship_intro',
    q: 'Tell me about someone who shaped who you became. How would you describe them?',
    digFor: 'their name, relationship, and 2–3 concrete traits or habits — not “they were wonderful”',
  },
  {
    module: 'Relationship Significance',
    category: 'relationship_significance',
    q: 'Why are they important to you? What part of who you are came from them?',
    digFor: 'a specific influence (habit, value, skill) they passed on, with a short example',
  },
  {
    module: 'Defining Story',
    category: 'relationship_story',
    q: 'What story best captures who they were — the memory that comes to mind first?',
    digFor: 'one memory with a beginning moment and what that person did or said',
  },
  {
    module: 'Parent Lessons',
    category: 'relationship_parents',
    q: 'What did your mother or father teach you that stayed with you your whole life?',
    digFor: 'which parent, the lesson in their words, and when they taught it if remembered',
  },
  {
    module: 'Wisdom — Marriage',
    category: 'wisdom_marriage',
    q: 'What makes a relationship last? What did love and marriage teach you?',
    digFor: 'one practical lesson from their relationship, with a small real example',
  },
  {
    module: 'Wisdom — Resilience',
    category: 'wisdom_resilience',
    q: 'How did you survive your hardest times? What kept you going?',
    digFor: 'what the hard time was (in brief) and what specifically helped them through',
  },
  {
    module: 'Future Generations',
    category: 'wisdom_future',
    q: 'What lesson took you decades to learn — something you hope your grandchildren understand early?',
    digFor: 'the late-learned lesson stated clearly, plus what experience taught it',
  },
];

export const ENRICHED_COVERAGE_CATEGORIES = ENRICHED_QUESTIONS.map((q) => q.category);
